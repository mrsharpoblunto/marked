import type { _Hooks } from './Hooks.ts';

type HookSlots<P, R> = Pick<_Hooks<P, R>, 'preprocess' | 'postprocess' | 'processAllTokens' | 'provideLexer' | 'provideParser' | 'emStrongMask'>;

const configuredHooks = new WeakMap<object, unknown>();

// Hooks use the public values and receiver. The checker cannot follow these slots.
function adaptHook<C, A extends unknown[], R>(context: C, hook: (this: C, ...args: A) => R): (...args: A) => R {
  return (...args) => hook.apply(context, args);
}

function createHookSlots<P, R>(hooks: _Hooks<P, R>): HookSlots<P, R> {
  return {
    preprocess: adaptHook(hooks, hooks.preprocess),
    postprocess: adaptHook(hooks, hooks.postprocess),
    processAllTokens: adaptHook(hooks, hooks.processAllTokens),
    provideLexer: adaptHook(hooks, hooks.provideLexer),
    provideParser: adaptHook(hooks, hooks.provideParser),
    emStrongMask: hooks.emStrongMask,
  };
}

export function configureHooks<P, R>(hooks: _Hooks<P, R>): void {
  configuredHooks.set(hooks, createHookSlots(hooks));
}

export function hookSlots<P, R>(hooks: _Hooks<P, R>): HookSlots<P, R> {
  return configuredHooks.get(hooks) as HookSlots<P, R> | undefined ?? createHookSlots(hooks);
}
