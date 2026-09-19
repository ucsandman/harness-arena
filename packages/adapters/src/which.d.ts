/**
 * `which@7` ships no type declarations and `@types/which` is not installed in this repo.
 * This declaration covers exactly the surface detect.ts uses.
 */
declare module 'which' {
  interface WhichOptions {
    path?: string;
    pathExt?: string;
    all?: boolean;
    nothrow?: boolean;
  }
  function which(cmd: string, options: WhichOptions & { nothrow: true }): Promise<string | null>;
  function which(cmd: string, options?: WhichOptions): Promise<string>;
  export = which;
}
