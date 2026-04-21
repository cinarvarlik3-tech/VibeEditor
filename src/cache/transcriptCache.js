'use strict';

const { cacheTranscriptRenderEnabled } = require('./config');
const { sha256File } = require('./hash');
const metrics      = require('./metrics');
const { transcribeAudio, languageHintForCache } = require('../transcription/transcribe');

/**
 * Transcribe with Supabase-backed content-addressable cache (audio bytes hash).
 *
 * @param {{ audioPath: string, language: string|null|undefined, supabaseAdmin: object|null }} opts
 * @returns {Promise<Array>}
 */
async function getOrTranscribeAudio({ audioPath, language, supabaseAdmin }) {
  const langKey = languageHintForCache(language);
  let hash = null;

  try {
    hash = await sha256File(audioPath);
  } catch (e) {
    console.warn('[transcriptCache] sha256 failed, transcribing without cache —', e.message);
    return transcribeAudio(audioPath, language || null);
  }

  if (!cacheTranscriptRenderEnabled() || !supabaseAdmin) {
    return transcribeAudio(audioPath, language || null);
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('transcript, hit_count')
      .eq('audio_hash', hash)
      .eq('language_hint', langKey)
      .maybeSingle();

    if (!error && data && data.transcript) {
      metrics.counts.transcriptHit += 1;
      const nextHits = (Number(data.hit_count) || 0) + 1;
      void supabaseAdmin
        .from('transcripts')
        .update({ hit_count: nextHits })
        .eq('audio_hash', hash)
        .eq('language_hint', langKey)
        .then(() => {}, () => {});
      return data.transcript;
    }
  } catch (e) {
    console.warn('[transcriptCache] lookup failed —', e.message);
  }

  metrics.counts.transcriptMiss += 1;
  const transcript = await transcribeAudio(audioPath, language || null);

  try {
    const { error: insErr } = await supabaseAdmin.from('transcripts').upsert(
      {
        audio_hash:    hash,
        language_hint: langKey,
        transcript,
        hit_count:     0,
        updated_at:    new Date().toISOString(),
      },
      { onConflict: 'audio_hash,language_hint' }
    );
    if (insErr) console.warn('[transcriptCache] upsert failed —', insErr.message);
  } catch (e) {
    console.warn('[transcriptCache] upsert exception —', e.message);
  }

  return transcript;
}

module.exports = { getOrTranscribeAudio };
