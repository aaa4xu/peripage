import example from './example.json';
import { parseTemplate } from './template';

/** Gridfinity geometry from the Swift Homebox label, with explicit text sizes. */
export function exampleTemplate() {
	return parseTemplate(example);
}
