import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CATEGORY_CATALOG } from '../categories/catalog';
import type { Category } from '../db/schema';

interface CategoryChipsProps {
  /** Categorías de la base; solo se muestran las del catálogo (con `slug`). */
  categories: readonly Category[];
  selectedId: number | null;
  /** Recibe el id elegido, o `null` si se tocó el chip ya elegido. */
  onChange: (categoryId: number | null) => void;
}

const CATALOG_ORDER = new Map(CATEGORY_CATALOG.map((category, index) => [category.slug, index]));

/**
 * Fila de chips para elegir el rubro de una tarea (US-4.1). Selección única y
 * opcional: tocar el chip elegido lo desmarca.
 *
 * @pre Ninguna.
 * @post Muestra un chip por rubro del catálogo, en el orden del catálogo, con su
 *       ícono y nombre; el elegido queda resaltado y anunciado como
 *       seleccionado. Tocar un chip llama a `onChange`. Sin rubros no dibuja nada.
 */
export function CategoryChips({ categories, selectedId, onChange }: CategoryChipsProps) {
  const chips = categories
    .filter((category) => category.slug !== null && CATALOG_ORDER.has(category.slug))
    .sort((a, b) => CATALOG_ORDER.get(a.slug!)! - CATALOG_ORDER.get(b.slug!)!);
  if (chips.length === 0) return null;

  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Rubro">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {chips.map((category) => {
          const selected = category.id === selectedId;
          const color = category.color ?? '#0f766e';
          return (
            <Pressable
              key={category.id}
              style={({ pressed }) => [
                styles.chip,
                selected && { backgroundColor: color, borderColor: color },
                pressed && styles.pressed,
              ]}
              onPress={() => onChange(selected ? null : category.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={category.name}
              accessibilityHint={selected ? 'Toca para quitar el rubro' : 'Avisa en cualquier local de este rubro'}
            >
              {category.icon && (
                <Text style={styles.icon} importantForAccessibility="no" accessibilityElementsHidden>
                  {category.icon}
                </Text>
              )}
              <Text style={[styles.label, selected && styles.labelSelected]}>{category.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8 },
  chip: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  pressed: { opacity: 0.8 },
  icon: { fontSize: 16 },
  label: { color: '#334155', fontWeight: '600' },
  labelSelected: { color: '#fff' },
});
