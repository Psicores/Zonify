// Punto de entrada de la app. Primero las tareas de fondo (US-1.1): tienen que
// quedar definidas al cargar el bundle, también en un arranque sin interfaz.
import './src/background';
import 'expo-router/entry';
