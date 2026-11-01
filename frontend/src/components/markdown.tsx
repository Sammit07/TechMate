"use client"

import Link from "next/link"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** Assistant answers: Markdown with [KB0010017] citations and INC ticket numbers turned into links. */
export function Markdown({ text }: { text: string }) {
  const linked = text
    .replace(/\[(KB\d{7})\]/g, "[$1](/kb/$1)")
    .replace(/\[(INC\d{7})\]/g, "[$1](/tickets/$1)")
    .replace(/(?<![[/\w])(INC\d{7})(?![\]\w])/g, "[$1](/tickets/$1)")
  return (
    <div className="prose-chat text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Model output is untrusted: no raw HTML, and links only to our KB, tickets or http(s).
        skipHtml
        components={{
          a: ({ href = "", children }) =>
            href.startsWith("/kb/") || href.startsWith("/tickets/") ? (
              <Link href={href} className="font-medium underline decoration-dotted underline-offset-2"
                    style={{ color: "var(--series-1)" }}>{children}</Link>
            ) : /^https?:\/\//.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{children}</a>
            ) : <>{children}</>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          code: ({ children }) => <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
        }}
      >
        {linked}
      </ReactMarkdown>
    </div>
  )
}
