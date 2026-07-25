declare module '*.css'
declare module '*?raw' {
  const contents: string
  export default contents
}
