import type { Task } from '../db/schema';

/** Ventana en la que los avisos de una tarea suenan (US-5.2). */
export interface AlertSchedule {
  /** Minuto del día (0–1439) desde el que suenan; `null` si no hay franja horaria. */
  startMinute: number | null;
  /** Minuto del día (0–1439) hasta el que suenan, incluido; `null` si no hay franja horaria. */
  endMinute: number | null;
  /** Días permitidos como máscara de bits (bit 0 = lunes … bit 6 = domingo); `null` = todos. */
  days: number | null;
}

/** Días de la semana en el orden en que se muestran, con su bit en la máscara. */
export const WEEK_DAYS = [
  { bit: 0, short: 'L', name: 'Lunes' },
  { bit: 1, short: 'M', name: 'Martes' },
  { bit: 2, short: 'X', name: 'Miércoles' },
  { bit: 3, short: 'J', name: 'Jueves' },
  { bit: 4, short: 'V', name: 'Viernes' },
  { bit: 5, short: 'S', name: 'Sábado' },
  { bit: 6, short: 'D', name: 'Domingo' },
] as const;

export const ALL_DAYS_MASK = 0b1111111;
export const WEEKDAYS_MASK = 0b0011111;
export const WEEKEND_MASK = 0b1100000;

/** Franja sugerida al activar el horario (horario comercial típico). */
export const DEFAULT_START_MINUTE = 8 * 60 + 30;
export const DEFAULT_END_MINUTE = 20 * 60 + 30;

/**
 * Lee la ventana de avisos guardada en una tarea.
 *
 * @pre Ninguna.
 * @post Devuelve los tres campos de la tarea tal cual.
 */
export function scheduleOf(
  task: Pick<Task, 'alertStartMinute' | 'alertEndMinute' | 'alertDays'>,
): AlertSchedule {
  return { startMinute: task.alertStartMinute, endMinute: task.alertEndMinute, days: task.alertDays };
}

/**
 * Indica si una tarea tiene alguna restricción de horario o días.
 *
 * @pre Ninguna.
 * @post Devuelve `true` si hay franja horaria o si los días no son todos.
 */
export function hasSchedule(schedule: AlertSchedule): boolean {
  return schedule.startMinute !== null || (schedule.days !== null && schedule.days !== ALL_DAYS_MASK);
}

/**
 * Bit del día de la semana de una fecha, en la hora local del teléfono.
 *
 * @pre Ninguna.
 * @post Devuelve 0 para lunes … 6 para domingo.
 */
function dayBit(date: Date): number {
  return (date.getDay() + 6) % 7;
}

/**
 * Indica si un día está permitido.
 *
 * @pre `bit` está en [0, 6].
 * @post Devuelve `true` si `days` es `null` o tiene ese bit.
 */
function dayAllowed(days: number | null, bit: number): boolean {
  return days === null || (days & (1 << bit)) !== 0;
}

/**
 * Indica si un aviso puede sonar en un momento dado (US-5.2).
 *
 * @pre Si hay franja, `startMinute` y `endMinute` están en [0, 1439].
 * @post Sin restricciones devuelve `true`. Con franja `desde ≤ hasta`, el minuto
 *       actual tiene que estar en [desde, hasta] y el día permitido. Con una
 *       franja que cruza la medianoche (`desde > hasta`, p. ej. 22:00–02:00), la
 *       parte de después de medianoche pertenece al día en que empezó, así que
 *       se mira el día anterior. Sin franja, solo cuenta el día.
 */
export function isWithinAlertWindow(schedule: AlertSchedule, now: Date): boolean {
  const { startMinute, endMinute, days } = schedule;
  const today = dayBit(now);
  if (startMinute === null || endMinute === null) return dayAllowed(days, today);

  const minute = now.getHours() * 60 + now.getMinutes();
  if (startMinute <= endMinute) {
    return minute >= startMinute && minute <= endMinute && dayAllowed(days, today);
  }
  if (minute >= startMinute) return dayAllowed(days, today);
  if (minute <= endMinute) return dayAllowed(days, (today + 6) % 7);
  return false;
}

/**
 * Convierte un texto «HH:MM» en minutos del día.
 *
 * @pre Ninguna (es lo que escribió el usuario).
 * @post Acepta `H:MM`, `HH:MM`, `HHMM` y `H` u `HH` (hora en punto), con
 *       espacios alrededor; devuelve el minuto del día, o `null` si el texto no
 *       es una hora válida (horas 0–23, minutos 0–59).
 */
export function parseTime(text: string): number | null {
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Formatea minutos del día como «HH:MM».
 *
 * @pre `minute` está en [0, 1439].
 * @post Devuelve la hora con dos dígitos para horas y minutos.
 */
export function formatTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Describe los días permitidos en pocas palabras.
 *
 * @pre `days` es `null` o está en [1, 127].
 * @post «Todos los días», «Lun a Vie», «Sáb y Dom» o la lista de iniciales
 *       («L, X, V»).
 */
export function describeDays(days: number | null): string {
  if (days === null || days === ALL_DAYS_MASK) return 'Todos los días';
  if (days === WEEKDAYS_MASK) return 'Lun a Vie';
  if (days === WEEKEND_MASK) return 'Sáb y Dom';
  return WEEK_DAYS.filter((d) => dayAllowed(days, d.bit))
    .map((d) => d.short)
    .join(', ');
}

/**
 * Describe la ventana de avisos para mostrarla en la lista.
 *
 * @pre Ninguna.
 * @post Devuelve `null` si no hay restricciones; si no, la franja «08:30–20:30»
 *       (si la hay) seguida de los días (si no son todos).
 */
export function describeSchedule(schedule: AlertSchedule): string | null {
  if (!hasSchedule(schedule)) return null;
  const parts: string[] = [];
  if (schedule.startMinute !== null && schedule.endMinute !== null) {
    parts.push(`${formatTime(schedule.startMinute)}–${formatTime(schedule.endMinute)}`);
  }
  if (schedule.days !== null && schedule.days !== ALL_DAYS_MASK) parts.push(describeDays(schedule.days));
  return parts.join(' · ');
}
