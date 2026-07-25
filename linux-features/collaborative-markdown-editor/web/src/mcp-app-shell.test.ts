// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import html from '../mcp-app.html?raw'

function shell(): Document {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return parsed
}

describe('production MCP App shell', () => {
  it('requires an explicit button gesture for exact workspace approval', () => {
    const document = shell()
    expect(document.querySelector('#authorization-root')).not.toBeNull()
    expect(document.querySelector('#authorization-path')).not.toBeNull()
    expect(document.querySelector<HTMLButtonElement>('#authorize')?.type).toBe(
      'button',
    )
    expect(document.querySelector('form')).toBeNull()
  })

  it('exposes accessible status, collaborator, conflict, and editor regions', () => {
    const document = shell()
    expect(document.querySelector('#message')?.getAttribute('aria-live')).toBe(
      'polite',
    )
    expect(document.querySelector('#presence')?.getAttribute('aria-label')).toBe(
      'Active collaborators',
    )
    expect(document.querySelector('#conflict')).not.toBeNull()
    expect(document.querySelector('#editor')?.getAttribute('aria-label')).toBe(
      'Collaborative Markdown document',
    )
    expect(document.querySelector('#preview')?.getAttribute('aria-pressed')).toBe(
      'true',
    )
  })

  it('contains no remote scripts, stylesheets, frames, or images', () => {
    const document = shell()
    expect(document.querySelectorAll('iframe, img, link[rel="stylesheet"]')).toHaveLength(0)
    const scripts = [...document.querySelectorAll<HTMLScriptElement>('script[src]')]
    expect(scripts).toHaveLength(1)
    expect(scripts[0]?.getAttribute('src')).toBe('/src/mcp-app.ts')
  })
})
