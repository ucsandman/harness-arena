import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isValidElement, type ReactNode } from 'react';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { slugifyHeading } from '@/lib/docs';
import { cn } from '@/lib/cn';

/** Flatten a React children tree to plain text (for heading ids and code block contents). */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function Heading({ level, children }: { level: 1 | 2 | 3 | 4; children: ReactNode }) {
  const text = textOf(children);
  const id = slugifyHeading(text);
  const anchor =
    level === 1 ? null : (
      <a href={`#${id}`} className="heading-anchor" aria-label={`Link to section: ${text}`}>
        #
      </a>
    );
  if (level === 1) return <h1 id={id}>{children}</h1>;
  if (level === 2)
    return (
      <h2 id={id}>
        {children}
        {anchor}
      </h2>
    );
  if (level === 3)
    return (
      <h3 id={id}>
        {children}
        {anchor}
      </h3>
    );
  return <h4 id={id}>{children}</h4>;
}

/**
 * Markdown rendering for the docs. GFM only, no raw HTML (react-markdown drops it by default and no
 * rehype-raw is installed), so nothing in a markdown file can inject markup.
 */
export function Markdown({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={cn('prose', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <Heading level={1}>{children}</Heading>,
          h2: ({ children }) => <Heading level={2}>{children}</Heading>,
          h3: ({ children }) => <Heading level={3}>{children}</Heading>,
          h4: ({ children }) => <Heading level={4}>{children}</Heading>,
          a: ({ href, children }) => {
            const url = href ?? '#';
            const external = /^https?:\/\//.test(url);
            return (
              <a href={url} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
                {children}
              </a>
            );
          },
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) {
              return <pre>{children}</pre>;
            }
            const language = /language-([\w-]+)/.exec(child.props.className ?? '')?.[1];
            return (
              <CodeBlock
                code={textOf(child.props.children).replace(/\n$/, '')}
                language={language}
                className="my-4"
              />
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/** Shown when a registry page exists but its markdown file has not been written yet. */
export function DocPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <div className="prose">
      <h1>{title}</h1>
      <p>{description}</p>
      <div className="rounded-card border border-warn-border bg-warn-subtle p-4 text-sm text-warn">
        <p className="font-medium">This page is being written.</p>
        <p className="mt-1 text-xs">
          The document is part of the planned set but is not in the repository yet. Nothing is broken; this
          section simply has no content to render.
        </p>
      </div>
    </div>
  );
}
