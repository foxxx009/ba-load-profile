// Pull real task ids from the local instance so the detail scenario measures a
// real, fully-populated row rather than a cache miss on a bogus id.
import fs from 'node:fs';
import { guardLocal, req } from './lib.mjs';
guardLocal();
const r = await req('/v1/tasks?status=all&limit=100');
const j = JSON.parse(r.body);
const tasks = j.tasks || [];
fs.writeFileSync('ids.json', JSON.stringify(tasks.map(t => ({ task_id: t.task_id, status: t.status })), null, 1));
console.log('wrote ids.json with', tasks.length, 'ids; sample:', tasks.slice(0,3).map(t=>t.task_id).join(','));
