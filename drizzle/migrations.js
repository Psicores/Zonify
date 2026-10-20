import journal from './meta/_journal.json';
import m0000 from './0000_init.sql';
import m0001 from './0001_rubros_y_pois.sql';
import m0002 from './0002_horario_de_avisos.sql';
import m0003 from './0003_avisos_y_ajustes.sql';
import m0004 from './0004_vaciar_datos.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004
    }
  }
  