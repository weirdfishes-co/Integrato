import express, { type Request, type RequestHandler, type Response } from 'express';

import { logger } from '../logger.js';
import { MAX_PDF_BYTES, PdfError, pdfToMarkdown } from '../pdf.js';

/**
 * The conversion step shared by the admin knowledge base and the users'
 * documents. It only converts: it stores nothing, so each caller keeps its own
 * rules about where the result goes and who may put it there. The browser gets
 * the Markdown back, shows or saves it through the path it already had.
 *
 * The body is the raw PDF (not JSON-wrapped base64, which is a third larger),
 * so this parser sits on the route and not globally.
 */
export const pdfBody: RequestHandler = express.raw({ type: 'application/pdf', limit: MAX_PDF_BYTES });

/** A file name the knowledge base accepts: letters, digits, _ and -, at most 64, plus .md. */
export function markdownName(filename: string): string {
  const stem = filename
    .replace(/\.pdf$/i, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 61);
  return `${stem || 'document'}.md`;
}

/** Call only after authorization: parsing a PDF is the expensive part. */
export async function convertPdf(req: Request, res: Response): Promise<void> {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(415).json({ error: 'Send the PDF as the request body (Content-Type: application/pdf).' });
    return;
  }
  const filename = typeof req.query.name === 'string' ? req.query.name : '';
  try {
    const { markdown, pages } = await pdfToMarkdown(req.body);
    res.json({ name: markdownName(filename), markdown, pages });
  } catch (error) {
    if (error instanceof PdfError) {
      res.status(422).json({ error: error.message });
      return;
    }
    logger.error({ err: error }, 'pdf conversion failed');
    res.status(500).json({ error: 'The PDF could not be converted.' });
  }
}
