import hashString from '@emotion/hash';
import { Properties as CSSProperties } from 'csstype';
// @ts-ignore
import { expand } from 'inline-style-expand-shorthand';
import { convertProperty } from 'rtl-css-js/core';

import { compileCSS } from './runtime/compileCSS';
import { insertStyles } from './insertStyles';

//
//
//

export type Renderer = {
  cache: Record<string, [string, string]>;
  node: HTMLStyleElement;
  index: number;
};
const targets = new WeakMap<Document, Renderer>();

export function createTarget(targetDocument: Document): Renderer {
  let target = targets.get(targetDocument);

  if (target) {
    return target;
  }

  const node = targetDocument.createElement('style');

  node.setAttribute('FCSS', 'RULE');
  targetDocument.head.appendChild(node);

  target = { cache: {}, node, index: 0 };

  targets.set(targetDocument, target);

  return target;
}

//
//
//

function isObject(val: any) {
  return val != null && typeof val === 'object' && Array.isArray(val) === false;
}

//
//
//

const canUseCSSVariables = window.CSS && CSS.supports('color', 'var(--c)');

//
// IE11 specific
//

// Create graph of inputs to map to output.
const graph = new Map();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const graphGet = (graphNode: Map<any, any>, path: any[]): any | undefined => {
  for (const key of path) {
    graphNode = graphNode.get(key);

    if (!graphNode) {
      return;
    }
  }

  return graphNode;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const graphSet = (graphNode: Map<any, any>, path: any[], value: any) => {
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];

    let current = graphNode.get(key);

    if (!current) {
      current = new Map();

      graphNode.set(key, current);
    }

    graphNode = current;
  }

  graphNode.set(path[path.length - 1], value);
};

//
//
//

const regex = /^(:|\[|>|&)/;

export default function isNestedSelector(property: string): boolean {
  return regex.test(property);
}

function normalizeNestedProperty(nestedProperty: string): string {
  if (nestedProperty.charAt(0) === '&') {
    return nestedProperty.slice(1);
  }

  return nestedProperty;
}

function createCSSVariablesProxy(tokens: any) {
  const g = {
    // @ts-ignore
    get(target: any, key: any) {
      if (isObject(target[key])) {
        return new Proxy({ ...target[key], value: (target.value ?? '') + '-' + key }, g);
      }

      return `var(--theme${target.value ?? ''}-${key})`;
    },
  };

  return new Proxy(tokens, g);
}

const HASH_PREFIX = 'a';

//
//
//

function resolveStyles(styles: any[], selector = '', result: any = {}): any {
  const expandedStyles = expand(styles);
  const properties = Object.keys(expandedStyles) as (keyof CSSProperties)[];

  properties.forEach(propName => {
    const propValue = expandedStyles[propName];

    if (propValue == null) {
    } else if (isObject(propValue)) {
      if (isNestedSelector(propName)) {
        // console.log(
        //   'nested selectors',
        //   propName,
        //   propValue,
        // );
        resolveStyles(propValue, selector + normalizeNestedProperty(propName), result);
      }
      // TODO: support media queries
      // TODO: support support queries
    } else if (typeof propValue === 'string' || typeof propValue === 'number') {
      const className = HASH_PREFIX + hashString(selector + propName + propValue);
      const css = compileCSS(className, selector, propName, propValue);

      // uniq key based on property & selector, used for merging later
      const key = selector + propName;

      // TODO: what can actually flip in RTL?!
      const rtl = convertProperty(propName, propValue);
      const flippedInRtl = rtl.key !== propName || rtl.value !== propValue;

      if (flippedInRtl) {
        const rtlCSS = compileCSS('r' + className, selector, rtl.key, rtl.value);

        // There is no sense to store RTL className as it's "r" + regular className
        result[key] = [className, css, rtlCSS];
      } else {
        result[key] = [className, css];
      }

      // console.log('EVAL', selector, propName, propValue);
      // console.log('KEY', key);
      // console.log('CSS', css);

      // }
    }
  });

  return result;
}

function matchersToBits(definitions: any, matchers: any) {
  if (!definitions.mapping) {
    let i = 0;
    definitions.mapping = {};
    definitions.forEach((definition: any) => {
      const matchers = definition[0];

      if (matchers === null) {
        return null;
      }

      Object.keys(matchers).forEach(matcherName => {
        const matcherValue = matchers[matcherName];
        const maskKey = '' + matcherName + matcherValue;

        definitions.mapping[maskKey] = 1 << i;
        i++;
      });
    }, {});
  }

  if (matchers === null) {
    return 0;
  }

  return selectorsToBits(definitions.mapping, matchers);
}

function selectorsToBits(mapping: any, selectors: any): number {
  let mask = 0;

  for (const selectorName in selectors) {
    const selectorValue = selectors[selectorName];
    const selectorInBits = mapping['' + selectorName + selectorValue];

    mask += selectorInBits || 0; // can be undefined
  }

  return mask;
}

function resolveStylesToClasses(definitions: any[], tokens: any) {
  const resolvedStyles = definitions.map((definition, i) => {
    const matchers = definition[0];
    const styles = definition[1];
    const resolvedStyles = definition[2];

    const areTokenDependantStyles = typeof styles === 'function';

    if (canUseCSSVariables) {
      // we can always use prebuilt styles in this case and static cache in runtime

      if (resolvedStyles) {
        return [matchers, null, resolvedStyles];
      }

      // matchers should be also converted to bit masks
      definitions[i][0] = matchersToBits(definitions, matchers);

      // if static cache is not present, eval it and mutate original object
      definitions[i][2] = resolveStyles(areTokenDependantStyles ? styles(tokens) : styles);

      return [definition[0], null, definition[2]];
    }

    // if CSS variables are not supported we have to re-eval only functions, otherwise static cache can be reused
    if (areTokenDependantStyles) {
      // An additional level of cache based on tokens to avoid style computation for IE11

      const path = [tokens, styles];
      const resolvedStyles = graphGet(graph, path);

      if (resolvedStyles) {
        return [matchers, resolvedStyles];
      }

      // matchers should be also converted to bit masks
      definitions[i][0] = matchersToBits(definitions, matchers);

      const resolveStyles1 = resolveStyles(styles(tokens));
      graphSet(graph, path, resolveStyles1);

      return [definitions[i][0], null, resolveStyles1];
    }

    if (resolvedStyles) {
      return [definitions[i][0], null, resolvedStyles];
    }

    // matchers should be also converted to bit masks
    definitions[i][0] = matchersToBits(definitions, matchers);
    definitions[i][2] = resolveStyles(styles);

    return [definitions[i][0], null, definition[2]];
  });

  // @ts-ignore
  resolvedStyles.mapping = definitions.mapping;

  return resolvedStyles;
}

/**
 * TODO: Update it with something proper...
 * CAN WORK WITHOUT REACT!
 */
export function makeNonReactStyles(styles: any) {
  const cxCache: Record<string, string> = {};

  return function ___(selectors: any, options: any, ...classNames: (string | undefined)[]): string {
    // If CSS variables are present we can use CSS variables proxy like in build time

    let tokens;
    let resolvedStyles;

    if (process.env.NODE_ENV === 'production') {
      tokens = canUseCSSVariables ? null : options.tokens;
      resolvedStyles = canUseCSSVariables ? styles : resolveStylesToClasses(styles, tokens);
    } else {
      tokens = canUseCSSVariables ? createCSSVariablesProxy(options.tokens) : options.tokens;
      resolvedStyles = resolveStylesToClasses(styles, tokens);
    }

    // Dumper for static styles
    // @ts-ignore
    // console.log(JSON.stringify(resolvedStyles.map(d => [d[0], null, d[1]])));
    // @ts-ignore
    // console.log(JSON.stringify(resolvedStyles.mapping));

    let nonMakeClasses: string = '';
    const overrides: any = {};
    let overridesCx = '';

    classNames.forEach(className => {
      if (typeof className === 'string') {
        className.split(' ').forEach(cName => {
          if (options.target.cache[cName] !== undefined) {
            overrides[options.target.cache[cName][0]] = options.target.cache[cName][1];
            overridesCx += cName;
          } else {
            nonMakeClasses += cName;
          }
        });
      }
    });

    // @ts-ignore
    const selectorsMask = selectorsToBits(resolvedStyles.mapping, selectors);

    const overridesHash = overridesCx === '' ? '' : overridesCx;
    const cxCacheKey = selectorsMask + '' + overridesHash;

    if (canUseCSSVariables && cxCache[cxCacheKey] !== undefined) {
      // TODO: OOPS, Does not support MW
      return nonMakeClasses + cxCache[cxCacheKey];
    }

    const matchedDefinitions = resolvedStyles.reduce((acc: any, definition: any) => {
      const matchersInBits = definition[0];

      if (matchersInBits === 0 || !!(matchersInBits & selectorsMask)) {
        acc.push(definition[2]);
      }

      return acc;
    }, []);

    const resultDefinitions = Object.assign({}, ...matchedDefinitions, overrides);
    const resultClasses = nonMakeClasses + insertStyles(resultDefinitions, options.rtl, options.target);

    cxCache[cxCacheKey] = resultClasses;

    return resultClasses;
  };
}

const defaultTarget = createTarget(document);

/*
 * A wrapper to connect to a React context. SHOULD USE unified context!!!
 */
export function makeStyles(styles: any) {
  const result = makeNonReactStyles(styles);

  return function ___(selectors: any = {}, ...classNames: string[]): string {
    return result(selectors, { rtl: false, tokens: {}, target: defaultTarget }, ...classNames);
  };
}
