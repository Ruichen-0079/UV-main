/**
 * Compile-time bridge for the official Cubism Core global.
 *
 * The executable Core remains an external, locally hosted SDK asset. This
 * declaration intentionally provides only the type surface used by the
 * vendored Web Framework sources.
 */
declare namespace Live2DCubismCore {
  type csmLogFunction = (message: string) => void;
  type csmParameterType = number;
  type Moc = any;
  type Model = any;
}

declare const Live2DCubismCore: any;
