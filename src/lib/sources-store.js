// Read/mutate config/sources.yaml via yaml's Document API so comments,
// key order, and formatting survive every edit. Used by the web UI (and
// callable from elsewhere if a CLI ever wants the same operations).
//
// All mutations write the full file synchronously after the change.
// Tiny enough not to need a write queue.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CONFIG_DIR } from './config.js';

const YAML_PATH = path.join(CONFIG_DIR, 'sources.yaml');

function readDoc() {
  const text = fs.readFileSync(YAML_PATH, 'utf8');
  return YAML.parseDocument(text);
}

function writeDoc(doc) {
  fs.writeFileSync(YAML_PATH, doc.toString(), 'utf8');
}

function serializeItem(item) {
  return {
    name:       item.get('name'),
    handle:     item.get('handle'),
    channel_id: item.get('channel_id') || '',
    enabled:    item.get('enabled') !== false,
  };
}

function listFor(node) {
  if (!node || !Array.isArray(node.items)) return [];
  return node.items.map(serializeItem);
}

export function listAll() {
  const doc = readDoc();
  const indivNode = doc.get('individuals');
  const individuals = indivNode && Array.isArray(indivNode.items)
    ? indivNode.items.map(i => i.value)
    : [];
  return {
    channels:    listFor(doc.get('channels')),
    individuals,
  };
}

// --- Channels ---------------------------------------------------------------

function findItemByHandle(node, handle) {
  if (!node || !Array.isArray(node.items)) return -1;
  return node.items.findIndex(i => i.get('handle') === handle);
}

export function addChannel({ name, handle, channel_id = '', enabled = true }) {
  if (!name?.trim()) throw new Error('name is required');
  if (!handle?.trim()) throw new Error('handle is required');
  if (!handle.startsWith('@')) throw new Error('handle must start with "@"');

  const doc = readDoc();
  let node = doc.get('channels');
  if (!node) {
    doc.set('channels', []);
    node = doc.get('channels');
  }
  if (findItemByHandle(node, handle) !== -1) {
    throw new Error(`handle ${handle} already exists`);
  }

  const itemObj = {
    name: name.trim(),
    handle: handle.trim(),
    channel_id: channel_id || '',
    ...(enabled === false ? { enabled: false } : {}),
  };
  node.items.push(doc.createNode(itemObj));
  writeDoc(doc);
  return { ...itemObj, enabled: enabled !== false };
}

export function removeChannel(handle) {
  const doc = readDoc();
  const node = doc.get('channels');
  const idx = findItemByHandle(node, handle);
  if (idx === -1) return false;
  node.items.splice(idx, 1);
  writeDoc(doc);
  return true;
}

export function patchChannel(handle, patch) {
  const doc = readDoc();
  const node = doc.get('channels');
  const idx = findItemByHandle(node, handle);
  if (idx === -1) return null;
  const item = node.items[idx];
  if ('enabled' in patch) {
    if (patch.enabled === false) item.set('enabled', false);
    else if (item.has('enabled')) item.delete('enabled');   // cleaner YAML when re-enabling
  }
  if ('channel_id' in patch) {
    item.set('channel_id', patch.channel_id || '');
  }
  if ('name' in patch && patch.name?.trim()) {
    item.set('name', patch.name.trim());
  }
  writeDoc(doc);
  return serializeItem(item);
}

// --- Individuals ------------------------------------------------------------

export function addIndividual(name) {
  if (!name?.trim()) throw new Error('name is required');
  const clean = name.trim();
  const doc = readDoc();
  let node = doc.get('individuals');
  if (!node) {
    doc.set('individuals', [clean]);
    writeDoc(doc);
    return clean;
  }
  if (node.items.some(i => i.value === clean)) {
    throw new Error(`individual "${clean}" already exists`);
  }
  node.items.push(doc.createNode(clean));
  writeDoc(doc);
  return clean;
}

export function removeIndividual(name) {
  const doc = readDoc();
  const node = doc.get('individuals');
  if (!node || !Array.isArray(node.items)) return false;
  const idx = node.items.findIndex(i => i.value === name);
  if (idx === -1) return false;
  node.items.splice(idx, 1);
  writeDoc(doc);
  return true;
}
