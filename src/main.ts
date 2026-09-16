import { Plugin } from 'obsidian';
import { createProvider } from './network';

export default class CollabPlugin extends Plugin {
  createProvider = createProvider;

  onload() {}

  onunload() {}
}
