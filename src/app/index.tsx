import { TasksScreen } from '../screens/TasksScreen';

/**
 * Ruta `/`: la lista de tareas.
 *
 * @pre Se renderiza dentro del layout raíz (migraciones aplicadas).
 * @post Muestra `TasksScreen`.
 */
export default function IndexRoute() {
  return <TasksScreen />;
}
