// Stand-in for @opentui/core, which the OpenCode terminal UI supplies at run time. Only what the plugins construct.
declare module '@opentui/core' {
  export class TextRenderable {
    constructor(renderer: unknown, options: { content: string })
    content: string
  }
}
