/**
 * Configuración de Babel para Metro.
 *
 * @pre `babel-preset-expo` y `babel-plugin-inline-import` están instalados.
 * @post Devuelve el preset de Expo y además convierte cada `import x from '*.sql'`
 *       en un string, para incluir las migraciones de Drizzle en el bundle.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['inline-import', { extensions: ['.sql'] }]],
  };
};
