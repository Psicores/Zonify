import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { TaskDetailScreen } from '../../../screens/TaskDetailScreen';

/**
 * Ruta `/tasks/:id`: detalle de una tarea.
 *
 * @pre Se navega con `id` igual al id de una tarea.
 * @post Si `id` es un entero positivo muestra `TaskDetailScreen`; si no, un
 *       mensaje de error.
 */
export default function TaskDetailRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const taskId = Number(id);

  if (!Number.isInteger(taskId) || taskId <= 0) {
    return (
      <View style={styles.center}>
        <Text>La tarea no existe.</Text>
      </View>
    );
  }
  return <TaskDetailScreen taskId={taskId} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
