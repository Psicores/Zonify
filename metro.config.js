const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.sourceExts.push('sql');

/**
 * Resume el contenido de las migraciones SQL de Drizzle.
 *
 * @pre Existe la carpeta `drizzle/` junto a este archivo.
 * @post Devuelve un hash corto que cambia si cambia, aparece o desaparece
 *       cualquier `.sql` de `drizzle/`.
 */
function migrationsHash() {
  const dir = path.join(__dirname, 'drizzle');
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    hash.update(name).update(fs.readFileSync(path.join(dir, name)));
  }
  return hash.digest('hex').slice(0, 12);
}

// babel-plugin-inline-import copia cada .sql dentro de drizzle/migrations.js,
// pero Metro no sabe que ese archivo depende de los .sql: si se regenera una
// migración y migrations.js queda con el mismo texto, Metro sigue sirviendo el
// SQL viejo desde su caché. Atar la versión de caché al contenido de los .sql
// la invalida al arrancar Metro después de cualquier cambio de migraciones.
config.cacheVersion = `${config.cacheVersion}-sql-${migrationsHash()}`;

module.exports = config;
