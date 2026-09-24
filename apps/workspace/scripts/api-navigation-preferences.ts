import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { preferencesPatchSchema } from '../shared/preferences';

// Update this one documented operation without overwriting later module routes.
const doc = JSON.parse(await readFile('docs/openapi.json', 'utf8'));
const operation = doc.paths['/me/preferences'].patch;
operation.summary = 'Save personal appearance, navigation and dashboard preferences';
operation.description = 'Current actual password session required. Partial updates merge with current account preferences and repeat session proof before commit. Theme light/dark/system; nine palettes and custom accent; contrast, text size, spacing, navigation density, corners, reduced motion, artwork, depth, home, dashboard card order/visibility, and complete workspaceNavOrder/organizationNavOrder permutations. Omitted orders remain unchanged. Unknown, duplicate, missing or wrong-group navigation IDs are rejected on writes. Stored legacy navigation gains current defaults without changing valid existing appearance choices. Preferences grant no access rights.';
operation.requestBody.content['application/json'].schema = z.toJSONSchema(preferencesPatchSchema, { io: 'input' });
await writeFile('docs/openapi.json', JSON.stringify(doc, null, 2) + '\n');
console.log('Updated personal navigation preferences contract.');
