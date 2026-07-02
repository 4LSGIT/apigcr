// lib/internal_functions/variables.js

const fns = {};

// ─────────────────────────────────────────────────────────────
// VARIABLE MANIPULATION
// ─────────────────────────────────────────────────────────────

/**
 * noop
 * Does nothing. Useful as a config-driven step that only uses
 * set_vars in the step config to set variables.
 *
 * example config:
 *   { "function_name": "noop", "params": {}, "set_vars": { "stage": "intake" } }
 */

fns.noop = async () => {
    console.log('[NOOP] Step executed');
    return { success: true };
  };

fns.noop.__meta = {
  category: 'variables',
  description: 'Does nothing. Useful as a config-driven step that only sets variables via set_vars.',
  params: [],
  example: {}
};

/**
 * set_var
 * Explicitly set one variable to a value.
 *
 * params:
 *   name   {string}  — variable name
 *   value  {any}     — value to assign
 *
 * example config:
 *   { "function_name": "set_var", "params": { "name": "stage", "value": "intake" } }
 */

fns.set_var = async (params) => {
    const { name, value } = params;
    if (!name) throw new Error('set_var requires a name');
    console.log(`[SET_VAR] ${name} = ${JSON.stringify(value)}`);
    return {
      success: true,
      set_vars: { [name]: value }
    };
  };

fns.set_var.__meta = {
  category: 'variables',
  description: 'Explicitly set one variable to a value.',
  params: [
    { name: 'name', type: 'string', required: true,
      description: 'Variable name.', example: 'stage' },
    { name: 'value', type: 'string', required: false, placeholderAllowed: true,
      description: 'Value to assign.', example: 'intake' },
  ],
  example: { name: 'stage', value: 'intake' }
};

/**
 * format_string
 * Build a string from a template and store it as a variable.
 * The engine resolves {{placeholders}} before this runs, so
 * `template` arrives already interpolated — this just stores it.
 *
 * params:
 *   template    {string}  — e.g. "Hello {{firstName}} {{lastName}}"
 *   output_var  {string}  — variable name to store the result in
 *
 * example config:
 *   {
 *     "function_name": "format_string",
 *     "params": { "template": "{{firstName}} {{lastName}}", "output_var": "fullName" }
 *   }
 */

fns.format_string = async (params) => {
    const { template, output_var } = params;
    if (!output_var) throw new Error('format_string requires output_var');
    const result = template ?? '';
    console.log(`[FORMAT_STRING] ${output_var} = "${result}"`);
    return {
      success: true,
      set_vars: { [output_var]: result }
    };
  };

fns.format_string.__meta = {
  category: 'variables',
  workflowOnly: true,
  description: 'Build a string from a template (placeholders resolved before this runs) and store it as a variable.',
  params: [
    { name: 'template', type: 'string', required: true, placeholderAllowed: true,
      multiline: true,
      description: 'Template string. {{placeholders}} are resolved by the engine before this runs.',
      example: 'Hello {{firstName}} {{lastName}}' },
    { name: 'output_var', type: 'string', required: true,
      description: 'Variable name to store the result in.', example: 'fullName' },
  ],
  example: { template: 'Hello {{firstName}}', output_var: 'greeting' }
};

module.exports = fns;
