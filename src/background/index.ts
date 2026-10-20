// Definiciones de todas las tareas de fondo. Se importa desde el punto de
// entrada (`index.ts`), antes que Expo Router: cuando el sistema despierta la
// app cerrada (geocerca, botón de un aviso, WorkManager) no se dibuja ninguna
// pantalla y `_layout.tsx` no llega a cargarse.
import '../geofencing/background';
import '../notifications/background';
import '../pois/background';
