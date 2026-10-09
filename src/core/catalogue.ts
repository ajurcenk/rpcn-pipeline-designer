// The ComponentCatalog (AD-20, ticket 3.3): which components exist, per category, and which of
// their fields hold child components, read from the cached transformed schema (AD-10). There is
// no hand-written table: a component from a newer binary, a plugin or another edition gets its
// slots from the schema the user's binary printed. Pure (AD-15).
//
// Slot rule: walk a component's schema node through `properties`, `items`, `patternProperties`
// and `additionalProperties` only, without expanding `$ref`. A field is a child slot when the
// walk reaches `{"$ref": "#/definitions/<c>"}` with `c` an input, processor or output. The last
// step sets the kind: a field (or the component's own value) is `single`, `items` is `list`,
// a pattern or additional property is `map`. Buffers, scanners and the rest are not slots.

import { isJsonObject, type JsonObject, type JsonValue } from './schema';

/** The categories whose components can be children of another component. */
export type SlotCategory = 'input' | 'processor' | 'output';

const SLOT_CATEGORIES: ReadonlySet<string> = new Set<SlotCategory>(['input', 'processor', 'output']);

/** One step from a component's value to its children. */
export type SlotStep =
	| { readonly kind: 'field'; readonly name: string }
	/** Every item of a sequence. */
	| { readonly kind: 'items' }
	/** Every entry of a mapping (a pattern or additional property). */
	| { readonly kind: 'entries' };

export type SlotKind = 'single' | 'list' | 'map';

/** A place in a component's config that holds child components of `category`. */
export interface Slot {
	/** From the component's value; empty when the value itself is the child (`reject_errored`). */
	readonly steps: readonly SlotStep[];
	readonly category: SlotCategory;
	readonly kind: SlotKind;
}

export interface CategoryCatalog {
	/** Every component name of the category, in schema order. */
	readonly names: ReadonlySet<string>;
	/** The child slots of each component that has any, in schema order. */
	readonly slots: ReadonlyMap<string, readonly Slot[]>;
	/** The fields every component of the category shares (`label`, `processors`, …). */
	readonly sharedFields: ReadonlySet<string>;
	/** Slots among the shared fields (an input's and an output's own `processors`). */
	readonly sharedSlots: readonly Slot[];
}

/** The catalogue by category (`definitions` key: `input`, `processor`, `cache`, …). */
export interface ComponentCatalog {
	readonly categories: ReadonlyMap<string, CategoryCatalog>;
}

const NO_SLOTS: readonly Slot[] = [];

/** The child slots of component `name` of `category`; none for an unknown one. */
export function slotsOf(catalogue: ComponentCatalog, category: string, name: string): readonly Slot[] {
	return catalogue.categories.get(category)?.slots.get(name) ?? NO_SLOTS;
}

/**
 * Derives the catalogue from a (raw or transformed) `list --format jsonschema` schema:
 * components at `definitions.<cat>.allOf[0].anyOf[i].properties.<name>`, shared fields at
 * `definitions.<cat>.allOf[1].properties`. Odd shapes are skipped. Never throws.
 */
export function componentCatalogue(schema: JsonObject): ComponentCatalog {
	const categories = new Map<string, CategoryCatalog>();
	const definitions = isJsonObject(schema.definitions) ? schema.definitions : {};
	for (const [category, definition] of Object.entries(definitions)) {
		if (!isJsonObject(definition) || !Array.isArray(definition.allOf)) {
			continue;
		}
		const [components, shared] = definition.allOf;
		const names = new Set<string>();
		const slots = new Map<string, readonly Slot[]>();
		const options = isJsonObject(components) && Array.isArray(components.anyOf) ? components.anyOf : [];
		for (const option of options) {
			if (!isJsonObject(option) || !isJsonObject(option.properties)) {
				continue;
			}
			for (const [name, node] of Object.entries(option.properties)) {
				if (names.has(name)) {
					continue;
				}
				names.add(name);
				const found = slotsIn(node);
				if (found.length > 0) {
					slots.set(name, found);
				}
			}
		}
		const sharedProperties = isJsonObject(shared) && isJsonObject(shared.properties) ? shared.properties : {};
		categories.set(category, {
			names,
			slots,
			sharedFields: new Set(Object.keys(sharedProperties)),
			sharedSlots: slotsIn({ properties: sharedProperties }),
		});
	}
	return { categories };
}

/** Every slot under `node`, in schema order. */
function slotsIn(node: JsonValue): Slot[] {
	const found: Slot[] = [];
	walk(node, [], found);
	// Two pattern properties can lead to the same place; keep one slot per place.
	const seen = new Set<string>();
	return found.filter((slot) => {
		const key = `${slot.category}:${formatSlot(slot)}`;
		return !seen.has(key) && seen.add(key) !== undefined;
	});
}

function walk(node: JsonValue, steps: SlotStep[], found: Slot[]): void {
	if (!isJsonObject(node)) {
		return;
	}
	if (typeof node.$ref === 'string') {
		const category = /^#\/definitions\/([^/]+)$/.exec(node.$ref)?.[1];
		if (category !== undefined && SLOT_CATEGORIES.has(category)) {
			const last = steps.at(-1);
			const kind: SlotKind = last?.kind === 'items' ? 'list' : last?.kind === 'entries' ? 'map' : 'single';
			found.push({ steps: [...steps], category: category as SlotCategory, kind });
		}
		return; // a `$ref` is never expanded
	}
	if (isJsonObject(node.properties)) {
		for (const [name, child] of Object.entries(node.properties)) {
			walk(child, [...steps, { kind: 'field', name }], found);
		}
	}
	if (isJsonObject(node.items)) {
		walk(node.items, [...steps, { kind: 'items' }], found);
	}
	if (isJsonObject(node.patternProperties)) {
		for (const child of Object.values(node.patternProperties)) {
			walk(child, [...steps, { kind: 'entries' }], found);
		}
	}
	if (isJsonObject(node.additionalProperties)) {
		walk(node.additionalProperties, [...steps, { kind: 'entries' }], found);
	}
}

/** A slot as text: `.cases[].output`, `[].processors[]`, `.branches.<name>.processors[]`, `<self>`. */
export function formatSlot(slot: Slot): string {
	if (slot.steps.length === 0) {
		return '<self>';
	}
	return slot.steps.map((s) => (s.kind === 'field' ? `.${s.name}` : s.kind === 'items' ? '[]' : '.<name>')).join('');
}
