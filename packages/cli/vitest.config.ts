import { defineConfig } from 'vitest/config';
import { pluginTests } from '@ogygia/tooling/vitest';

// (the digest test reads profiler reports through @ogygia/devtools, whose modules use Svelte runes)
export default defineConfig(pluginTests());
