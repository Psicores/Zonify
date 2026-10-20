import { useLayoutEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderHandlers,
} from 'react-native';

export interface SwipeAction {
  label: string;
  color: string;
  /** Se ejecuta al soltar pasado el umbral; si rechaza, la fila vuelve a su lugar. */
  onTrigger: () => Promise<void>;
}

interface SwipeableRowProps {
  children: ReactNode;
  /** Acción al deslizar hacia la derecha (se revela a la izquierda). */
  right: SwipeAction;
  /** Acción al deslizar hacia la izquierda (se revela a la derecha). */
  left: SwipeAction;
  /** Avisan cuándo empieza y termina un gesto, p. ej. para pausar el scroll de la lista. */
  onSwipeStart?: () => void;
  onSwipeEnd?: () => void;
  /** Toque simple sobre la fila. */
  onPress?: () => void;
  /** Qué hace el toque, para lectores de pantalla. */
  pressHint?: string;
}

type SwipeCallbacks = Pick<SwipeableRowProps, 'right' | 'left' | 'onSwipeStart' | 'onSwipeEnd'>;

// Fracción del ancho que hay que recorrer para disparar la acción, o la mitad
// de eso si el dedo se suelta rápido.
const TRIGGER_RATIO = 0.35;
const FLING_VELOCITY = 0.8;
// Movimiento mínimo antes de reclamar el gesto, para no robarle toques ni scroll a la lista.
const ACTIVATION_DISTANCE = 12;

/**
 * Crea el estado del gesto de una fila, fuera del ciclo de render de React.
 *
 * @pre `initial` son las props con que se monta la fila.
 * @post Devuelve `translateX` (posición animada de la fila), los `panHandlers`
 *       para la vista que se arrastra, `fire` para disparar una acción sin gesto,
 *       y `setCallbacks` / `setWidth` para mantener al día las props y el ancho.
 */
function createSwipeController(initial: SwipeCallbacks) {
  const translateX = new Animated.Value(0);
  let callbacks = initial;
  let width = 0;
  let busy = false;

  /**
   * Devuelve la fila a su posición.
   *
   * @pre Ninguna.
   * @post La fila vuelve animada a `translateX = 0` y admite un nuevo gesto.
   */
  const reset = () => {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start(() => {
      busy = false;
    });
  };

  /**
   * Saca la fila hacia un lado y ejecuta la acción de ese lado.
   *
   * @pre `direction` es 1 (derecha) o -1 (izquierda).
   * @post Si no había otra acción en curso, anima la salida y llama a `onTrigger`;
   *       si falla, llama a `reset`. Con una acción en curso no hace nada.
   */
  const fire = (direction: 1 | -1) => {
    if (busy) return;
    busy = true;
    const action = direction === 1 ? callbacks.right : callbacks.left;
    Animated.timing(translateX, {
      toValue: direction * Math.max(width, 1),
      duration: 160,
      useNativeDriver: true,
    }).start(() => {
      action.onTrigger().catch(reset);
    });
  };

  const responder = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) =>
      !busy && Math.abs(g.dx) > ACTIVATION_DISTANCE && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderGrant: () => callbacks.onSwipeStart?.(),
    onPanResponderMove: (_, g) => translateX.setValue(g.dx),
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_, g) => {
      callbacks.onSwipeEnd?.();
      const threshold = width * TRIGGER_RATIO;
      const flung = Math.abs(g.vx) > FLING_VELOCITY && Math.sign(g.vx) === Math.sign(g.dx);
      if (Math.abs(g.dx) > threshold || (flung && Math.abs(g.dx) > threshold / 2)) {
        fire(g.dx > 0 ? 1 : -1);
      } else {
        reset();
      }
    },
    onPanResponderTerminate: () => {
      callbacks.onSwipeEnd?.();
      reset();
    },
  });

  return {
    translateX,
    panHandlers: responder.panHandlers as GestureResponderHandlers,
    fire,
    setCallbacks: (next: SwipeCallbacks) => {
      callbacks = next;
    },
    setWidth: (next: number) => {
      width = next;
    },
  };
}

/**
 * Fila que se desliza horizontalmente para disparar una de dos acciones. Usa
 * `PanResponder` y `Animated` de React Native, así que no necesita módulos nativos.
 * Los lectores de pantalla acceden a las mismas acciones como acciones de accesibilidad.
 *
 * @pre `children` tiene fondo opaco (tapa el fondo de colores de las acciones).
 * @post Al soltar pasado el umbral, la fila sale de la pantalla en ese sentido y
 *       se llama a `onTrigger` una sola vez; si la promesa rechaza, la fila vuelve
 *       a su lugar. Por debajo del umbral, vuelve a su lugar sin llamar a nada.
 *       Un toque sin arrastrar llama a `onPress`, si se indicó.
 */
export function SwipeableRow({
  children,
  right,
  left,
  onSwipeStart,
  onSwipeEnd,
  onPress,
  pressHint,
}: SwipeableRowProps) {
  const [controller] = useState(() => createSwipeController({ right, left, onSwipeStart, onSwipeEnd }));
  const { translateX, panHandlers, fire, setCallbacks, setWidth } = controller;
  useLayoutEffect(() => {
    setCallbacks({ right, left, onSwipeStart, onSwipeEnd });
  });

  const rightOpacity = translateX.interpolate({
    inputRange: [0, ACTIVATION_DISTANCE],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const leftOpacity = translateX.interpolate({
    inputRange: [-ACTIVATION_DISTANCE, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  /**
   * Ejecuta la acción pedida por un lector de pantalla.
   *
   * @pre Ninguna.
   * @post `'activate'` llama a `onPress`, `'swipeRight'` dispara `right` y
   *       `'swipeLeft'` dispara `left`; otras acciones se ignoran.
   */
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'activate') onPress?.();
    else if (event.nativeEvent.actionName === 'swipeRight') fire(1);
    else if (event.nativeEvent.actionName === 'swipeLeft') fire(-1);
  };

  return (
    <View
      style={styles.container}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityHint={pressHint}
      accessibilityActions={[
        ...(onPress ? [{ name: 'activate' }] : []),
        { name: 'swipeRight', label: right.label },
        { name: 'swipeLeft', label: left.label },
      ]}
      onAccessibilityAction={onAccessibilityAction}
    >
      <Animated.View
        style={[styles.action, styles.actionRight, { backgroundColor: right.color, opacity: rightOpacity }]}
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={styles.actionText}>{right.label}</Text>
      </Animated.View>
      <Animated.View
        style={[styles.action, styles.actionLeft, { backgroundColor: left.color, opacity: leftOpacity }]}
        importantForAccessibility="no-hide-descendants"
      >
        <Text style={styles.actionText}>{left.label}</Text>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panHandlers}>
        <Pressable onPress={onPress} disabled={!onPress} importantForAccessibility="no">
          {children}
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderRadius: 12, overflow: 'hidden' },
  action: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  actionRight: { alignItems: 'flex-start' },
  actionLeft: { alignItems: 'flex-end' },
  actionText: { color: '#fff', fontWeight: '700' },
});
