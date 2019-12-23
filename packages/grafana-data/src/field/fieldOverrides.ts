import set from 'lodash/set';
import { DynamicConfigValue, FieldConfig, InterpolateFunction, DataFrame, Field, FieldType } from '../types';
import { fieldMatchers, ReducerID, reduceField } from '../transformations';
import { FieldMatcher } from '../types/transformations';
import isNumber from 'lodash/isNumber';
import { getDisplayProcessor } from './displayProcessor';
import { GetFieldDisplayValuesOptions } from './fieldDisplay';
import { configFields } from './fieldConfigProcessor';

interface OverrideProps {
  match: FieldMatcher;
  properties: DynamicConfigValue[];
}

interface GlobalMinMax {
  min: number;
  max: number;
}

export function findNumericFieldMinMax(data: DataFrame[]): GlobalMinMax {
  let min = Number.MAX_VALUE;
  let max = Number.MIN_VALUE;

  const reducers = [ReducerID.min, ReducerID.max];
  for (const frame of data) {
    for (const field of frame.fields) {
      if (field.type === FieldType.number) {
        const stats = reduceField({ field, reducers });
        if (stats[ReducerID.min] < min) {
          min = stats[ReducerID.min];
        }
        if (stats[ReducerID.max] > max) {
          max = stats[ReducerID.max];
        }
      }
    }
  }

  return { min, max };
}

/**
 * Return a copy of the DataFrame with all rules applied
 */
export function applyFieldOverrides(options: GetFieldDisplayValuesOptions): DataFrame[] {
  if (!options.data) {
    return [];
  }
  const source = options.fieldOptions;
  if (!source) {
    return options.data;
  }
  let range: GlobalMinMax | undefined = undefined;

  // Prepare the Matchers
  const override: OverrideProps[] = [];
  if (source.overrides) {
    for (const rule of source.overrides) {
      const info = fieldMatchers.get(rule.matcher.id);
      if (info) {
        override.push({
          match: info.get(rule.matcher),
          properties: rule.properties,
        });
      }
    }
  }

  return options.data.map((frame, index) => {
    let name = frame.name;
    if (!name) {
      name = `Series[${index}]`;
    }

    const fields = frame.fields.map(field => {
      // Config is mutable within this scope
      const config: FieldConfig = { ...field.config } || {};
      if (field.type === FieldType.number) {
        setFieldConfigDefaults(config, source.defaults);
      }

      // Find any matching rules and then override
      for (const rule of override) {
        if (rule.match(field)) {
          for (const prop of rule.properties) {
            setDynamicConfigValue(config, {
              value: prop,
              config,
              field,
              data: frame,
              replaceVariables: options.replaceVariables,
            });
          }
        }
      }

      // Set the Min/Max value automatically
      if (options.autoMinMax && field.type === FieldType.number) {
        if (!isNumber(config.min) || !isNumber(config.max)) {
          if (!range) {
            range = findNumericFieldMinMax(options.data!); // Global value
          }
          if (!isNumber(config.min)) {
            config.min = range.min;
          }
          if (!isNumber(config.max)) {
            config.max = range.max;
          }
        }
      }

      return {
        ...field,

        // Overwrite the configs
        config,

        // Set the display processor
        processor: getDisplayProcessor({
          type: field.type,
          config: config,
          theme: options.theme,
        }),
      };
    });

    return {
      ...frame,
      fields,
      name,
    };
  });
}

interface DynamicConfigValueOptions {
  value: DynamicConfigValue;
  config: FieldConfig;
  field: Field;
  data: DataFrame;
  replaceVariables: InterpolateFunction;
}

export function setDynamicConfigValue(config: FieldConfig, options: DynamicConfigValueOptions) {
  const { value } = options;
  const cfg = configFields.get(value.path);
  if (cfg) {
    const existing = (config as any)[value.path];
    const val = cfg.processValue(value.value, existing, {} as InterpolateFunction);
    if (val === null || val === undefined) {
      return;
    }
    set(config, value.path, val);
  }
}

/**
 * For numeric values, only valid numbers will be applied
 * for units, 'none' will be skipped
 */
export function setFieldConfigDefaults(config: FieldConfig, props?: FieldConfig) {
  if (props) {
    const keys = Object.keys(props);
    for (const key of keys) {
      let val = (props as any)[key];
      if (key === 'custom') {
        console.log('TODO process custom values', val);
        continue;
      }
      const cfg = configFields.get(key);
      if (cfg) {
        const existing = (config as any)[key];
        val = cfg.processValue(val, existing, {} as InterpolateFunction);
        if (val === null || val === undefined) {
          continue;
        }
        set(config, key, val);
      } else {
        // Should we remove unused properties?
      }
    }
  }

  // First value is always -Infinity
  if (config.thresholds && config.thresholds.length) {
    config.thresholds[0].value = -Infinity;
  }

  // Verify that max > min (swap if necessary)
  if (config.hasOwnProperty('min') && config.hasOwnProperty('max') && config.min! > config.max!) {
    const tmp = config.max;
    config.max = config.min;
    config.min = tmp;
  }
}
