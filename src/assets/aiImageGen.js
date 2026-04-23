/**
 * src/assets/aiImageGen.js
 *
 * Gemini image generation wrapper for the Scan for Visuals pipeline.
 * Uses gemini-2.5-flash-image (Nano Banana) by default — ~$0.039/image at 1K.
 *
 * Input:  a natural-language prompt (typically candidate.ideal_visual_description
 *         from Pass 1, optionally with a style suffix).
 * Output: { pngBuffer: Buffer, mimeType: 'image/png', model, promptUsed }.
 *
 * Throws on API error, refused generation, or missing key. Caller decides
 * whether to persist the result (we do NOT upload from this module — the
 * user has to explicitly accept before anything reaches Supabase).
 */

'use strict';

require('dotenv').config();

const MODEL_IMAGE_DEFAULT = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

/**
 * Style suffix appended to every prompt. Pass 1's ideal_visual_description
 * is already cinematographer-style; this just reinforces vertical framing
 * and forbids text/logos (Gemini otherwise tends to add captions unprompted).
 * Deliberately short — over-stuffing produces over-stylized "AI look" images.
 */
const DEFAULT_STYLE_SUFFIX =
  'Photorealistic, cinematic framing, natural lighting, shallow depth of field. ' +
  'No text, watermarks, or logos. Vertical 9:16 composition.';

let _clientPromise = null;
async function getGenAiClient() {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set in environment');
    }
    const { GoogleGenAI } = await import('@google/genai');
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  })();
  return _clientPromise;
}

/**
 * @param {string} description  Typically candidate.ideal_visual_description.
 * @param {{ model?: string, styleSuffix?: string|null }} [opts]
 * @returns {Promise}
 */
async function generateImageFromDescription(description, opts = {}) {
  const model = opts.model || MODEL_IMAGE_DEFAULT;
  const desc = String(description || '').trim();
  if (!desc) {
    throw new Error('generateImageFromDescription: description is required');
  }

  const styleSuffix = opts.styleSuffix === null
    ? ''
    : (opts.styleSuffix || DEFAULT_STYLE_SUFFIX);
  const prompt = styleSuffix ? `${desc}\n\n${styleSuffix}` : desc;

  const client = await getGenAiClient();

  let response;
  try {
    response = await client.models.generateContent({
      model,
      contents: prompt,
    });
  } catch (err) {
    throw new Error(`generateImageFromDescription: API call failed — ${err.message || err}`);
  }

  const parts =
    response &&
    response.candidates &&
    response.candidates[0] &&
    response.candidates[0].content &&
    response.candidates[0].content.parts;

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('generateImageFromDescription: model returned no content parts');
  }

  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline && inline.data) {
      const mimeType = inline.mimeType || inline.mime_type || 'image/png';
      const pngBuffer = Buffer.from(inline.data, 'base64');
      return { pngBuffer, mimeType, model, promptUsed: prompt };
    }
  }

  // No image part — surface any text part (usually a safety refusal).
  const textPart = parts.find(p => typeof p.text === 'string' && p.text.trim());
  if (textPart) {
    throw new Error(
      `generateImageFromDescription: model refused or returned text — ${textPart.text.slice(0, 200)}`
    );
  }
  throw new Error('generateImageFromDescription: no image in response');
}

module.exports = {
  generateImageFromDescription,
  MODEL_IMAGE_DEFAULT,
  DEFAULT_STYLE_SUFFIX,
};
