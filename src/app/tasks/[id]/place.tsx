import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { PlacePickerScreen } from '../../../screens/PlacePickerScreen';

/**
 * Ruta `/tasks/:id/place`: elegir el lugar específico de una tarea.
 *
 * @pre Se navega con `id` igual al id de una tarea.
 * @post Si `id` es un entero positivo muestra `PlacePickerScreen`; si no, un
 *       mensaje de error.
 */
export default function TaskPlaceRoute() {
  const { id } = useLocalSearchParams<'/tasks/[id]/place'>();
  const taskId = Number(id);

  if (!Number.isInteger(taskId) || taskId <= 0) {
    return (
      <View style={styles.center}>
        <Text>La tarea no existe.</Text>
      </View>
    );
  }
  return <PlacePickerScreen taskId={taskId} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
});
