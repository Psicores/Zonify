// Drizzle migrations are inlined as strings by babel-plugin-inline-import.
declare module '*.sql' {
  const content: string;
  export default content;
}
