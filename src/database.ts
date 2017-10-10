import * as request from 'request';
import { Observable } from 'rxjs';
import { camelCase } from 'lodash';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { TYPES, RARITIES } from './types';

const RateLimiter = require('limiter').RateLimiter;
var limiter = new RateLimiter(10, 1500); // at most 5 request every 1500 ms
const throttledRequest = function(...requestArgs) {
  limiter.removeTokens(1, function() {
    request.post.apply(this, requestArgs);
  });
};

const WIKI_URL = "https://wiki.guildwars2.com/api.php";
const CACHE_FILE = "./cache.json";
let CACHE = undefined;

function getMatches(str, regex) {
  const matches = Object.create(null);
  let match;
  while (match = regex.exec(str)) {
    matches[camelCase(match[1])] = match[2];
  }

  return matches;
}

async function initCache() {
  if ( existsSync(CACHE_FILE) ) {
    CACHE = JSON.parse(readFileSync(CACHE_FILE).toString('utf-8'));
  } else {
    CACHE = await buildSkeleton(false);
    writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
  }
}

function storeCache(itemType: string, rarity: string, itemLevel: string, value: any) {
  CACHE[itemType][rarity][itemLevel] = value;
  return new Observable((observer) => {
    try {
      writeFileSync(CACHE_FILE, JSON.stringify(CACHE));
    } catch (err) {
      observer.error(err);
    }
    observer.next(value);
    observer.complete();
  })
  .do((v) => console.log(`written to cache ${rarity} ${itemType} of level ${itemLevel}`));
}

function addAttributes(originalItem: any, addMap: { [key: string]: number }): any {
  return Object.keys(addMap).reduce((curValue, keyName) => {
    return {
      ...curValue,
      [keyName]: (parseInt(curValue[keyName], 10) + addMap[keyName]).toString(),
    };
  }, originalItem);
}

// Fixes attributes for acended trinkets + back.
// translation of
// |<!-- Ascended or legendary trinkets and back items
//   -->{{#vardefine:major attribute asc|{{#expr:{{#var:major attribute}}+32}}}}<!--
//   -->{{#vardefine:minor attribute asc|{{#expr:{{#var:minor attribute}}+18}}}}<!--
//   -->{{#vardefine:major quad attribute asc|{{#expr:{{#var:major quad attribute}}+25}}}}<!--
//   -->{{#vardefine:minor quad attribute asc|{{#expr:{{#var:minor quad attribute}}+12}}}}<!--
//   -->{{#vardefine:celestial nbr asc|{{#expr:{{#var:celestial nbr}}+13}}}}<!--
//   -->{{#switch:{{#replace:{{lc:{{{1|}}}}}|'s|}}
// Source: https://wiki.guildwars2.com/index.php?title=Template:prefix_attributes&action=edit
function fixAcended(itemInfo: any) {
  if ( (itemInfo.rarityStd !== 'ascended') ||
       ((itemInfo.supertype !== 'back item') &&
        (itemInfo.supertype !== 'trinket')) ) {
    return itemInfo;
  }

  return addAttributes(itemInfo, {
    majorAttribute: 32,
    minorAttribute: 18,
    majorQuadAttribute: 25,
    minorQuadAttribute: 12,
    celestialNbr: 13,
  });
}

function queryTemplate(itemType: string, rarity: string, itemLevel: string) {
  return queryTemplateCache(itemType, rarity, itemLevel)
    .then((v) => fixAcended(v))
}

async function queryTemplateCache(itemType: string, rarity: string, itemLevel: string) {
  if ( undefined === CACHE ) {
    await initCache();
  }

  if ( CACHE[itemType][rarity][itemLevel] ) {
    return CACHE[itemType][rarity][itemLevel];
  }

  return _queryTemplate(itemType, rarity, itemLevel)
  .switchMap((value) => storeCache(itemType, rarity, itemLevel, value))
  .toPromise();
}

// https://wiki.guildwars2.com/wiki/Template:Item_stat_lookup
// Used by: https://wiki.guildwars2.com/wiki/Template:Prefix_attributes
function _queryTemplate(itemType, rarity, itemLevel): Observable<any> {
  const template = `
    {{item stat lookup|type=${itemType}|rarity=${rarity}|level=${itemLevel}}}
    #var:major attribute={{#var:major attribute|0}}
    #var:minor attribute={{#var:minor attribute|0}}
    #var:major quad attribute={{#var:major quad attribute|0}}
    #var:minor quad attribute={{#var:minor quad attribute|0}}
    #var:celestial nbr={{#var:celestial nbr|0}}
    #var:boon duration={{#var:boon duration|0}}
    #var:condition duration={{#var:condition duration|0}}
    #var:magic find={{#var:magic find|0}}
    #var:type_ori={{#var:type_ori|0}}
    #var:type_std={{#var:type_std|0}}
    #var:rarity_std={{#var:rarity_std|0}}
    #var:attribute_lu={{#var:attribute_lu|0}}
    #var:defense_lu={{#var:defense_lu|0}}
    #var:level_lu={{#var:level_lu|0}}
    #var:strength_lu={{#var:strength_lu|0}}
    #var:supertype={{#var:supertype|0}}
    #var:defense={{#var:defense|0}}
    #var:min strength={{#var:min strength|0}}
    #var:max strength={{#var:max strength|0}}
  `;

  return new Observable<string>((observer) => {
      throttledRequest(WIKI_URL, {
        form: {
          action: 'expandtemplates',
          format: 'jsonfm',
          text: template,
          prop: 'wikitext',
          wrappedhtml: 1,
        }
      }, (err, resp, body) => {
        console.log(`pulled ${rarity} ${itemType} of level ${itemLevel}`);
        if ( err ) {
          return observer.error(err);
        }

        if ( resp.statusCode !== 200 ) {
          return observer.error('Failed request');
        }

        observer.next(body);
        observer.complete();
    });
  })
  .retry(10)
  .map((v) => JSON.parse(v))
  .map((v) => v['html'])
  .map((v) => v.match(/(\{(.|\n)+\})/g)[0])
  .map((v) => JSON.parse(v))
  .map((v) => v['expandtemplates'])
  .map((v) => v['wikitext'])
  .map((v) => getMatches(v, /#var:(.+?)=([^\n]+)/g))
}

function promiseForObject<T>(
  object: {[key: string]: () => Promise<T>}
): Promise<{[key: string]: T}> {
  const keys = Object.keys(object);
  const valuesAndPromises = keys.map(name => object[name]());
  return Promise.all(valuesAndPromises).then(
    values => values.reduce((resolvedObject, value, i) => {
      resolvedObject[keys[i]] = value;
      return resolvedObject;
    }, Object.create(null))
  );
}

function promiseForObjectSerially<T>(
  object: {[key: string]: Promise<T>}
): Promise<{[key: string]: T}> {
  if ( typeof object === 'function' ) {
    return promiseForObjectSerially(object());
  }

  const keys = Object.keys(object);
  return Promise.resolve().then(() => {
    return keys.reduce((promiseObject, key, i) =>
      promiseObject.then(async (resolvedObject) => {
      const value = await object[key];
      resolvedObject[key] = value;
      return resolvedObject;
    }), Promise.resolve({}));
  });
}

function promiseForObjectDeep(object, nest) {
  if ( typeof object === 'function' ) {
    return promiseForObjectDeep(object(), nest);
  }

  if ( nest > 0 ) {
    const innerObj = Object.keys(object).reduce((newObj, key: string) => {
      return Object.assign(newObj, {
        [key]: promiseForObjectDeep(object[key], nest - 1),
      });
    }, {});

    return promiseForObjectSerially(innerObj);
  }

  return promiseForObject(object);
}

function buildSkeleton(pullValues: boolean = false) {
  const itemLevels = Array.from(Array(80).keys()).map((v) => (v+1).toString());
  const allInfo = TYPES.reduce((obj, weaponType: string) => {
    return Object.assign(obj, {
      [weaponType]: RARITIES.reduce((itemObj, rarityType: string) => {
        return Object.assign(itemObj, {
          [rarityType]: itemLevels.reduce((rarityObj, itemLevel: string) => {
            return Object.assign(rarityObj, {
              [itemLevel.toString()]: pullValues ?
                () => queryTemplate(weaponType, rarityType, itemLevel) : null,
            });
          }, {}),
        });
      }, {}),
    });
  }, {});

  if ( pullValues ) {
    return promiseForObjectDeep(allInfo, 2);
  } else {
    return Promise.resolve(allInfo);
  }
}

export function fetchDb() {
  return initCache().then(() => buildSkeleton(true));
}

export default fetchDb;
