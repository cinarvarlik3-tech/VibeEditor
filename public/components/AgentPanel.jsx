// ─────────────────────────────────────────────────────────────────────────────
// AgentPanel.jsx
// Right-column AI agent panel — conversation history, prompt input,
// undo/redo controls, and undo-last-prompt.
//
// Globals consumed:  React, Motion, LucideReact
// Sets global:       window.AgentPanel
// No import / export statements.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const { useState, useEffect, useRef } = React;
  const { motion, AnimatePresence }     = Motion;
  const { ArrowUp, Loader, AlertCircle, Undo2, Redo2, RotateCcw, Wand2, AlertTriangle, Info, Image } = LucideReact;

  // ── Timestamp formatter ──────────────────────────────────────────────────
  function fmtTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Message renderers ────────────────────────────────────────────────────

  function UserBubble({ msg }) {
    const label = msg.editLabel;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginBottom: 12 }}>
        {label ? (
          <span style={{
            color:        'rgba(0,188,212,0.45)',
            fontSize:     10,
            fontWeight:   600,
            marginBottom: 4,
            letterSpacing: 0.3,
          }}>
            {label}
          </span>
        ) : null}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          style={{
            background:   '#00897B',
            borderRadius: '12px 12px 2px 12px',
            padding:      '10px 14px',
            maxWidth:     '85%',
            color:        '#ffffff',
            fontSize:     13,
            lineHeight:   1.5,
          }}
        >
          {msg.content}
        </motion.div>
        <span style={{ color: 'rgba(0,188,212,0.5)', fontSize: 10, marginTop: 4 }}>
          {fmtTime(msg.timestamp)}
        </span>
      </div>
    );
  }

  function StatusMessage({ msg }) {
    return (
      <motion.div
        key={msg.id}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        style={{
          background:   'rgba(0,188,212,0.06)',
          borderLeft:   '2px solid #00BCD4',
          borderRadius: '0 4px 4px 0',
          padding:      '8px 12px',
          marginBottom: 8,
          color:        '#00BCD4',
          fontSize:     12,
          display:      'flex',
          alignItems:   'center',
          gap:          8,
        }}
      >
        <Loader size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
        {msg.content}
      </motion.div>
    );
  }

  function InfoMessage({ msg }) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background:   'rgba(96, 165, 250, 0.08)',
          borderLeft:   '2px solid #60A5FA',
          borderRadius: '0 6px 6px 0',
          padding:      '10px 12px',
          marginBottom: 12,
          color:        '#B8D4F0',
          fontSize:     13,
          lineHeight:   1.55,
          display:      'flex',
          alignItems:   'flex-start',
          gap:          8,
        }}
      >
        <Info size={14} color="#60A5FA" style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          {msg.editLabel ? (
            <div style={{
              fontSize:      10,
              fontWeight:    700,
              color:         'rgba(147, 197, 253, 0.95)',
              marginBottom:  4,
              letterSpacing: 0.35,
            }}>
              {msg.editLabel}
            </div>
          ) : null}
          <span>{msg.content}</span>
        </div>
      </motion.div>
    );
  }

  function ErrorMessage({ msg }) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        style={{
          background:   'rgba(255,59,48,0.06)',
          borderLeft:   '2px solid #FF3B30',
          borderRadius: '0 4px 4px 0',
          padding:      '8px 12px',
          marginBottom: 8,
          color:        '#FF6B6B',
          fontSize:     12,
          display:      'flex',
          alignItems:   'flex-start',
          gap:          8,
        }}
      >
        <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>{msg.content}</span>
      </motion.div>
    );
  }

  function ResultMessage({ msg }) {
    const { summary, prompt, isWarning, editLabel } = msg.content || {};
    const warn = !!isWarning;
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        style={{
          background:   warn ? 'rgba(186,117,23,0.08)' : 'rgba(0,137,123,0.10)',
          border:       warn ? '1px solid rgba(186,117,23,0.45)' : '1px solid rgba(0,188,212,0.25)',
          borderRadius: 8,
          padding:      '10px 12px',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
          {editLabel ? (
            <span style={{
              color:        warn ? 'rgba(186,117,23,0.85)' : 'rgba(0,188,212,0.75)',
              fontSize:     10,
              fontWeight:   700,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
            }}>
              {editLabel}
            </span>
          ) : null}
          {warn ? (
            <AlertTriangle size={13} color="#BA7517" style={{ flexShrink: 0 }} />
          ) : (
            <Wand2 size={13} color="#00BCD4" style={{ flexShrink: 0 }} />
          )}
          <span style={{ color: warn ? '#BA7517' : '#00BCD4', fontSize: 12, fontWeight: 600, flex: 1, minWidth: 0 }}>
            {summary}
          </span>
        </div>
        {prompt ? (
          <div style={{ color: '#555', fontSize: 11, fontStyle: 'italic' }}>
            {`"${prompt}"`}
          </div>
        ) : null}
      </motion.div>
    );
  }

  // ── Visual candidates (Pass 1) ───────────────────────────────────────────
  function VisualCandidatesPanel({
    msg,
    onFindAssets,
    onUseNative,
    onCreateImageClip,
    onClaudePickAsset,
    onAiGenerate,
    onAiAccept,
    projectId,
  }) {
    const [local, setLocal] = useState(function() {
      var raw = (msg.content && msg.content.candidates) ? msg.content.candidates.slice() : [];
      var list = raw.map(function(c, i) {
        var uid = (c.candidate_id != null && c.candidate_id !== '')
          ? ('cid_' + String(c.candidate_id))
          : ('tmp_' + i + '_' + String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8));
        return Object.assign({}, c, { __vuid: uid });
      });
      return {
        list: list,
        expanded: {},
        loading: {},
        assets: {},
        confirm: {},
        warn: {},
        aiGenerating: {},
        aiPreview: {},
        aiAccepting: {},
        aiAccepted: {},
        aiError: {},
      };
    });

    function fmtRange(c) {
      var a = c.start_time != null ? c.start_time : c.startTime;
      var b = c.end_time != null ? c.end_time : c.endTime;
      return (Number(a) || 0).toFixed(1) + 's – ' + (Number(b) || 0).toFixed(1) + 's';
    }

    function priStyle(p) {
      var x = String(p || '').toLowerCase();
      if (x === 'critical') return { bg: 'rgba(239,68,68,0.2)', color: '#F87171', lab: 'CRITICAL' };
      if (x === 'high') return { bg: 'rgba(249,115,22,0.2)', color: '#FB923C', lab: 'HIGH' };
      if (x === 'medium') return { bg: 'rgba(234,179,8,0.2)', color: '#FACC15', lab: 'MEDIUM' };
      return { bg: 'rgba(156,163,175,0.15)', color: '#9CA3AF', lab: 'LOW' };
    }

    function clsColor(mc) {
      var palette = {
        hook: '#22D3EE', explanation: '#A78BFA', proof: '#34D399', contrast: '#F472B6',
        transition: '#94A3B8', example: '#FBBF24', instruction: '#60A5FA', entity_mention: '#C084FC',
        emotional_peak: '#FB7185', payoff: '#4ADE80', CTA: '#38BDF8', retention_rescue: '#F97316',
      };
      return palette[mc] || '#64748B';
    }

    function vkey(cand) {
      return cand.__vuid || String(cand.candidate_id != null ? cand.candidate_id : '');
    }

    async function onFindClick(cand) {
      var k = vkey(cand);
      setLocal(function(prev) {
        var n = Object.assign({}, prev);
        n.loading = Object.assign({}, n.loading, { [k]: true });
        return n;
      });
      try {
        var res = await onFindAssets(cand);
        if (res.lowConfidence) {
          setLocal(function(prev) {
            var n = Object.assign({}, prev);
            n.loading = Object.assign({}, n.loading, { [k]: false });
            n.warn = Object.assign({}, n.warn, { [k]: 'Confidence too low for Pixabay retrieval. Use native component instead.' });
            return n;
          });
          return;
        }
        if (res.searchError) {
          setLocal(function(prev) {
            var n = Object.assign({}, prev);
            n.loading = Object.assign({}, n.loading, { [k]: false });
            n.warn = Object.assign({}, n.warn, { [k]: String(res.searchError) });
            return n;
          });
          return;
        }
        setLocal(function(prev) {
          var n = Object.assign({}, prev);
          n.loading = Object.assign({}, n.loading, { [k]: false });
          n.assets = Object.assign({}, n.assets, { [k]: res.assets || [] });
          n.expanded = Object.assign({}, n.expanded, { [k]: true });
          return n;
        });
      } catch (e) {
        setLocal(function(prev) {
          var n = Object.assign({}, prev);
          n.loading = Object.assign({}, n.loading, { [k]: false });
          n.warn = Object.assign({}, n.warn, { [k]: String(e.message || e) });
          return n;
        });
      }
    }

    async function onUseThis(cand, asset) {
      try {
        var hdr = { 'Content-Type': 'application/json' };
        var tok = window.Auth && typeof window.Auth.getToken === 'function' && window.Auth.getToken();
        if (tok) hdr.Authorization = 'Bearer ' + tok;
        var r = await fetch('/api/pixabay/ingest', {
          method:  'POST',
          headers: hdr,
          body: JSON.stringify({
            assetId: asset.id,
            assetType: asset.type,
            downloadUrl: asset.downloadUrl,
            projectId: projectId,
            duration: asset.duration,
          }),
        });
        var data = await r.json().catch(function() { return {}; });
        if (!r.ok) throw new Error(data.error || 'Ingest failed');
        var st = cand.start_time != null ? cand.start_time : cand.startTime;
        var et = cand.end_time != null ? cand.end_time : cand.endTime;
        onCreateImageClip({
          src: data.permanentUrl,
          storageRef: data.storageRef,
          startTime: st,
          endTime: et,
          duration: data.duration,
          sourceName: (function() {
            var parts = [asset.contributor, asset.tags].filter(Boolean);
            var s = parts.join(' · ');
            return (s && s.slice(0, 120)) || 'Pixabay';
          })(),
          sourceType: 'pixabay',
          pixabayId: asset.id,
        });
        var vk = vkey(cand);
        setLocal(function(prev) {
          var n = Object.assign({}, prev);
          n.confirm = Object.assign({}, n.confirm, { [vk]: 'Added to timeline' });
          n.expanded = Object.assign({}, n.expanded, { [vk]: false });
          return n;
        });
      } catch (e) {
        window.alert(e.message || 'Ingest failed');
      }
    }

    async function onClaudePick(cand, assets) {
      var chosen = await onClaudePickAsset(cand, assets);
      if (chosen) await onUseThis(cand, chosen);
    }

    async function onAiGenerateClick(cand) {
      var vk = vkey(cand);
      setLocal(function(prev) {
        var n = Object.assign({}, prev);
        n.aiGenerating = Object.assign({}, n.aiGenerating, { [vk]: true });
        n.aiError = Object.assign({}, n.aiError, { [vk]: '' });
        n.aiAccepted = Object.assign({}, n.aiAccepted);
        delete n.aiAccepted[vk];
        return n;
      });
      try {
        var result = await onAiGenerate(cand);
        if (!result || !result.success) {
          throw new Error((result && result.error) || 'Generation failed');
        }
        setLocal(function(prev) {
          var n = Object.assign({}, prev);
          n.aiGenerating = Object.assign({}, n.aiGenerating, { [vk]: false });
          n.aiPreview = Object.assign({}, n.aiPreview, {
            [vk]: {
              base64: result.base64,
              mimeType: result.mimeType || 'image/png',
              model: result.model || '',
            },
          });
          n.aiAccepted = Object.assign({}, n.aiAccepted);
          delete n.aiAccepted[vk];
          return n;
        });
      } catch (e) {
        setLocal(function(prev) {
          var n = Object.assign({}, prev);
          n.aiGenerating = Object.assign({}, n.aiGenerating, { [vk]: false });
          n.aiError = Object.assign({}, n.aiError, { [vk]: String(e.message || e) });
          return n;
        });
      }
    }

    async function onAiAcceptClick(cand) {
      var vk = vkey(cand);
      var preview = local.aiPreview[vk];
      if (!preview || !preview.base64) return;

      setLocal(function(prev) {
        var n = Object.assign({}, prev);
        n.aiAccepting = Object.assign({}, n.aiAccepting, { [vk]: true });
        n.aiError = Object.assign({}, n.aiError, { [vk]: '' });
        return n;
      });
      try {
        var result = await onAiAccept(cand, preview);
        if (!result || !result.success) {
          throw new Error((result && result.error) || 'Accept failed');
        }
        setLocal(function(prev) {
          var n = Object.assign({}, prev);
          n.aiAccepting = Object.assign({}, n.aiAccepting, { [vk]: false });
          n.aiAccepted = Object.assign({}, n.aiAccepted, { [vk]: true });
          n.aiPreview = Object.assign({}, n.aiPreview);
          delete n.aiPreview[vk];
          return n;
        });
      } catch (e) {
        setLocal(function(prev) {
          var n = Object.assign({}, prev);
          n.aiAccepting = Object.assign({}, n.aiAccepting, { [vk]: false });
          n.aiError = Object.assign({}, n.aiError, { [vk]: String(e.message || e) });
          return n;
        });
      }
    }

    function skipCand(vuid) {
      setLocal(function(prev) {
        var n = Object.assign({}, prev);
        n.list = prev.list.filter(function(c) { return c.__vuid !== vuid; });
        return n;
      });
    }

    if (!local.list.length) {
      return (
        <div style={{ color: '#555', fontSize: 12, marginBottom: 12 }}>No visual candidates.</div>
      );
    }

    return (
      <div style={{ marginBottom: 14 }}>
        {local.list.map(function(cand) {
          var ps = priStyle(cand.priority);
          var mc = cand.moment_class || '';
          var vk = vkey(cand);
          return (
            <motion.div
              key={vk}
              layout
              initial={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{
                background: '#1A1A1A',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 8,
                padding: 10,
                marginBottom: 10,
              }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 10, color: '#888', fontFamily: 'monospace' }}>{fmtRange(cand)}</span>
                <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: clsColor(mc) + '22', color: clsColor(mc) }}>{mc || '—'}</span>
                <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: ps.bg, color: ps.color }}>{ps.lab}</span>
              </div>
              <div style={{ color: '#888', fontSize: 12, fontStyle: 'italic', marginBottom: 6 }}>{cand.reason || ''}</div>
              {cand.ideal_visual_description ? (
                <div style={{
                  color: '#666',
                  fontSize: 11,
                  lineHeight: 1.45,
                  marginBottom: 8,
                  paddingLeft: 8,
                  borderLeft: '2px solid rgba(45,212,191,0.25)',
                }}>
                  <span style={{ color: '#5EEAD4', fontWeight: 600, fontSize: 10, letterSpacing: 0.3 }}>IDEAL VISUAL</span>
                  <br />
                  {cand.ideal_visual_description}
                </div>
              ) : null}
              {local.warn[vk] ? (
                <div style={{ color: '#FBBF24', fontSize: 11, marginBottom: 6 }}>{local.warn[vk]}</div>
              ) : null}
              {local.confirm[vk] ? (
                <div style={{ color: '#2DD4BF', fontSize: 11, marginBottom: 6 }}>{local.confirm[vk]}</div>
              ) : null}
              {local.aiError[vk] ? (
                <div style={{ color: '#FBBF24', fontSize: 11, marginBottom: 6 }}>
                  {'AI Generate: ' + local.aiError[vk]}
                </div>
              ) : null}
              {local.aiAccepted[vk] ? (
                <div style={{ color: '#2DD4BF', fontSize: 11, marginBottom: 6 }}>Added to timeline</div>
              ) : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {function() {
                  var cardBusy = !!(local.aiGenerating[vk] || local.aiAccepting[vk]);
                  var btnDis = { opacity: cardBusy ? 0.55 : 1, cursor: cardBusy ? 'not-allowed' : 'pointer' };
                  return (
                    <React.Fragment>
                      <button
                        type="button"
                        disabled={cardBusy}
                        onClick={function() { if (!cardBusy) onFindClick(cand); }}
                        style={Object.assign({ fontSize: 11, padding: '4px 10px', borderRadius: 999, border: 'none', background: '#0D9488', color: '#fff' }, btnDis)}
                      >
                        {local.loading[vk] ? 'Searching Pixabay…' : 'Find Components'}
                      </button>
                      <button
                        type="button"
                        disabled={cardBusy}
                        onClick={function() { if (!cardBusy) onAiGenerateClick(cand); }}
                        style={Object.assign({
                          fontSize: 11,
                          padding: '4px 10px',
                          borderRadius: 999,
                          border: '1px solid rgba(45,212,191,0.45)',
                          background: 'rgba(45,212,191,0.12)',
                          color: '#5EEAD4',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                        }, btnDis)}
                      >
                        {local.aiGenerating[vk] ? (
                          <React.Fragment>
                            <Loader size={12} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                            <span>Generating…</span>
                          </React.Fragment>
                        ) : (
                          <span>{local.aiPreview[vk] ? 'Regenerate' : 'AI Generate'}</span>
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={cardBusy}
                        onClick={function() { if (!cardBusy) onUseNative(cand); }}
                        style={Object.assign({ fontSize: 11, padding: '4px 10px', borderRadius: 999, border: '1px solid rgba(167,139,250,0.5)', background: 'rgba(139,92,246,0.15)', color: '#C4B5FD' }, btnDis)}
                      >
                        Native
                      </button>
                      <button
                        type="button"
                        disabled={cardBusy}
                        onClick={function() { if (!cardBusy) skipCand(cand.__vuid); }}
                        style={Object.assign({ fontSize: 11, padding: '4px 10px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: '#888' }, btnDis)}
                      >
                        Skip
                      </button>
                    </React.Fragment>
                  );
                }()}
              </div>
              {local.aiPreview[vk] && !local.aiAccepted[vk] ? (
                <div style={{ marginTop: 10, maxWidth: 240 }}>
                  <div style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)', background: '#111' }}>
                    <img
                      src={'data:' + local.aiPreview[vk].mimeType + ';base64,' + local.aiPreview[vk].base64}
                      alt=""
                      style={{ width: '100%', aspectRatio: '9/16', objectFit: 'cover', display: 'block' }}
                    />
                    <div style={{ padding: 4 }}>
                      <button
                        type="button"
                        disabled={!!local.aiAccepting[vk]}
                        onClick={function() { if (!local.aiAccepting[vk]) onAiAcceptClick(cand); }}
                        style={{
                          width: '100%',
                          fontSize: 10,
                          padding: '3px 0',
                          border: 'none',
                          borderRadius: 4,
                          background: '#0D9488',
                          color: '#fff',
                          cursor: local.aiAccepting[vk] ? 'not-allowed' : 'pointer',
                          opacity: local.aiAccepting[vk] ? 0.7 : 1,
                        }}
                      >
                        {local.aiAccepting[vk] ? 'Adding…' : 'Accept'}
                      </button>
                    </div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 9, color: '#64748B', lineHeight: 1.4 }}>
                    {'AI-generated preview · ' + (local.aiPreview[vk].model || 'gemini') + '. Click Regenerate above for a new version.'}
                  </div>
                </div>
              ) : null}
              {local.expanded[vk] && local.assets[vk] && local.assets[vk].length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <button type="button" onClick={function() { onClaudePick(cand, local.assets[vk]); }} style={{ fontSize: 10, marginBottom: 8, padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(45,212,191,0.4)', background: 'rgba(45,212,191,0.1)', color: '#5EEAD4', cursor: 'pointer' }}>Let Claude Pick</button>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                    {local.assets[vk].slice(0, 9).map(function(asset) {
                      var thumb = asset.thumbnailUrl || asset.previewUrl || '';
                      return (
                        <div
                          key={asset.id}
                          title={asset.contributor ? '© ' + asset.contributor : ''}
                          style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)', background: '#111' }}
                        >
                          {thumb ? (
                            <img src={thumb} alt="" style={{ width: '100%', aspectRatio: '9/16', objectFit: 'cover', display: 'block' }} />
                          ) : (
                            <div style={{ width: '100%', aspectRatio: '9/16', background: '#222', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontSize: 10 }}>No preview</div>
                          )}
                          {asset.type === 'video' && asset.duration ? (
                            <span style={{ position: 'absolute', top: 4, right: 4, fontSize: 9, background: 'rgba(0,0,0,0.65)', color: '#fff', padding: '1px 4px', borderRadius: 3 }}>{asset.duration}s</span>
                          ) : null}
                          <div style={{ padding: 4 }}>
                            <button type="button" onClick={function() { onUseThis(cand, asset); }} style={{ width: '100%', fontSize: 10, padding: '3px 0', border: 'none', borderRadius: 4, background: '#0D9488', color: '#fff', cursor: 'pointer' }}>Use This</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 9, color: '#64748B', lineHeight: 1.4 }}>
                    Photos and videos shown above are from{' '}
                    <a href="https://pixabay.com/" target="_blank" rel="noopener noreferrer" style={{ color: '#5EEAD4' }}>Pixabay</a>
                    {' '}(see Pixabay license for use).
                  </div>
                </div>
              ) : null}
            </motion.div>
          );
        })}
      </div>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────
  function EmptyState() {
    return (
      <div style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        height:         '100%',
        gap:            10,
        userSelect:     'none',
      }}>
        <div style={{
          width:          40,
          height:         40,
          borderRadius:   10,
          background:     '#222',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          color:          '#333',
          fontWeight:     700,
          fontSize:       16,
          letterSpacing:  1,
        }}>VE</div>
        <span style={{ color: '#555', fontSize: 13 }}>Describe your edit</span>
        <span style={{ color: '#333', fontSize: 11 }}>Load a video, then type a prompt</span>
      </div>
    );
  }

  // ── Main AgentPanel ──────────────────────────────────────────────────────
  const pillBtn = {
    fontSize:      11,
    padding:       '4px 10px',
    borderRadius:  999,
    border:        '1px solid rgba(255,255,255,0.1)',
    background:    'rgba(255,255,255,0.04)',
    color:         '#888',
    cursor:        'pointer',
    lineHeight:    1.3,
  };

  function fmtTok(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toLocaleString();
  }

  function AgentPanel({
    messages            = [],
    isProcessing        = false,
    claudeUsageLast     = null,
    claudeUsageSessionTotal = 0,
    currentFile         = null,
    hasPromptCheckpoint = false,
    hasConversationHistory = false,
    hasCachedTranscript = false,
    projectId           = null,
    onSubmitPrompt,
    onUndo,
    onRedo,
    onUndoLastPrompt,
    onQuickUndoLastEdit,
    onExplainLastChange,
    onClearConversationHistory,
    onVisualScan,
    onFindAssets,
    onUseNative,
    onCreateImageClip,
    onClaudePickAsset,
    onAiGenerate,
    onAiAccept,
  }) {
    const [inputText,  setInputText]  = useState('');
    const [language,   setLanguage]   = useState('Auto');
    const messagesEndRef = useRef(null);
    const textareaRef    = useRef(null);
    const MAX_CHARS      = 500;

    // Auto-scroll to bottom when messages change
    useEffect(() => {
      messagesEndRef.current && messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Auto-grow textarea
    function handleTextareaInput() {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    }

    function handleKeyDown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    }

    function handleSubmit() {
      const text = inputText.trim();
      if (!text || isProcessing) return;
      onSubmitPrompt && onSubmitPrompt(text, language !== 'Auto' ? language.toLowerCase() : null);
      setInputText('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    }

    const canSend = inputText.trim().length > 0 && !isProcessing && !!currentFile;

    function renderMessage(msg) {
      switch (msg.type) {
        case 'user':   return <UserBubble    key={msg.id} msg={msg} />;
        case 'status': return <StatusMessage key="status" msg={msg} />;
        case 'info':   return <InfoMessage   key={msg.id} msg={msg} />;
        case 'error':  return <ErrorMessage  key={msg.id} msg={msg} />;
        case 'result': return <ResultMessage key={msg.id} msg={msg} />;
        case 'visual_candidates':
          return (
            <VisualCandidatesPanel
              key={msg.id}
              msg={msg}
              projectId={projectId}
              onFindAssets={onFindAssets}
              onUseNative={onUseNative}
              onCreateImageClip={onCreateImageClip}
              onClaudePickAsset={onClaudePickAsset}
              onAiGenerate={onAiGenerate}
              onAiAccept={onAiAccept}
            />
          );
        default:       return null;
      }
    }

    return (
      <div style={{
        display:       'flex',
        flexDirection: 'column',
        height:        '100%',
        background:    '#161616',
        overflow:      'hidden',
      }}>

        {/* ── Top bar ────────────────────────────────────────────────── */}
        <div style={{
          flexShrink:     0,
          background:     '#111111',
          borderBottom:   '1px solid rgba(255,255,255,0.08)',
          padding:        '6px 16px 8px',
        }}>
          <div style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'space-between',
            gap:            8,
            marginBottom:   4,
          }}>
          <span style={{ color: '#ffffff', fontSize: 14, fontWeight: 600 }}>
            Vibe Editor
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {/* Undo */}
            <button
              onClick={onUndo}
              title="Undo (Cmd+Z)"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#888', padding: '4px 6px', borderRadius: 4,
                display: 'flex', alignItems: 'center',
              }}
              onMouseEnter={e => e.currentTarget.style.color = '#fff'}
              onMouseLeave={e => e.currentTarget.style.color = '#888'}
            >
              <Undo2 size={14} />
            </button>
            {/* Redo */}
            <button
              onClick={onRedo}
              title="Redo (Cmd+Shift+Z)"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#888', padding: '4px 6px', borderRadius: 4,
                display: 'flex', alignItems: 'center',
              }}
              onMouseEnter={e => e.currentTarget.style.color = '#fff'}
              onMouseLeave={e => e.currentTarget.style.color = '#888'}
            >
              <Redo2 size={14} />
            </button>
            {/* Pulse dot */}
            <div
              className="pulse-dot"
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: '#00BCD4', marginLeft: 4,
              }}
              title="Ready"
            />
          </div>
          </div>
          <div
            title="OpenAI Chat Completions usage (prompt_tokens + completion_tokens) — same numbers as the server REAL token log, not the char÷4 estimate. 'cache read' is OpenAI's automatic prompt-cache hit (cheaper). 'server memo' means the response was served from the server's in-memory duplicate-request cache (no API call; $0)."
            style={{
              fontSize:     10,
              lineHeight:   1.35,
              color:        'rgba(0,188,212,0.75)',
              fontFamily:   'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              whiteSpace:   'nowrap',
              overflow:     'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {(() => {
              if (!claudeUsageLast) {
                return 'LLM Tokens (API): — (send a prompt; usage comes from /generate)';
              }
              if (claudeUsageLast.llmCacheHit) {
                return (
                  'LLM Tokens (last): server memo (duplicate request; no API call)' +
                  ` · session Σ ${fmtTok(claudeUsageSessionTotal)}`
                );
              }
              const inN = Number(claudeUsageLast.inputTokens);
              const outN = Number(claudeUsageLast.outputTokens);
              let totalReal = null;
              if (Number.isFinite(inN) && Number.isFinite(outN)) {
                totalReal = inN + outN;
              } else if (Number.isFinite(Number(claudeUsageLast.totalTokens))) {
                totalReal = Number(claudeUsageLast.totalTokens);
              }
              const cacheR = Number(claudeUsageLast.cacheReadInputTokens) || 0;
              const fresh = Math.max(0, Number(inN) - cacheR);
              const cacheBit = cacheR > 0
                ? ` (fresh ${fmtTok(fresh)} + cached ${fmtTok(cacheR)})`
                : '';
              return (
                `LLM Tokens (API, last): in ${fmtTok(inN)}${cacheBit} + out ${fmtTok(outN)} = ${fmtTok(totalReal)}` +
                ` · session Σ ${fmtTok(claudeUsageSessionTotal)}`
              );
            })()}
          </div>
        </div>

        {/* ── Conversation history ───────────────────────────────────── */}
        <div style={{
          flex:          1,
          overflowY:     'auto',
          padding:       16,
          display:       'flex',
          flexDirection: 'column',
        }}>
          {messages.length === 0
            ? <EmptyState />
            : messages.map(renderMessage)
          }
          <div ref={messagesEndRef} />
        </div>

        {/* ── Prompt input (anchored bottom) ─────────────────────────── */}
        <div style={{
          flexShrink: 0,
          background: '#111111',
          borderTop:  '1px solid rgba(255,255,255,0.08)',
          padding:    '12px 16px',
        }}>

          {hasPromptCheckpoint && (
            <button
              onClick={onUndoLastPrompt}
              style={{
                display:        'flex',
                alignItems:     'center',
                gap:            6,
                width:          '100%',
                background:     'rgba(255,152,0,0.08)',
                border:         '1px solid rgba(255,152,0,0.25)',
                borderRadius:   6,
                padding:        '7px 10px',
                color:          '#FF9800',
                fontSize:       12,
                cursor:         'pointer',
                marginBottom:   10,
                textAlign:      'left',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,152,0,0.14)'}
              onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,152,0,0.08)'}
            >
              <RotateCcw size={12} />
              Undo Last Prompt
            </button>
          )}

          {/* Context pill */}
          <div style={{ marginBottom: 8 }}>
            {currentFile ? (
              <span style={{
                display:      'inline-flex',
                alignItems:   'center',
                gap:          4,
                border:       '1px solid #00BCD4',
                borderRadius: 20,
                padding:      '2px 8px',
                color:        '#00BCD4',
                fontSize:     10,
                maxWidth:     '100%',
                overflow:     'hidden',
                textOverflow: 'ellipsis',
                whiteSpace:   'nowrap',
              }}>
                {currentFile.filename}
              </span>
            ) : (
              <span style={{ color: '#444', fontSize: 11 }}>No video loaded</span>
            )}
          </div>

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={e => setInputText(e.target.value.slice(0, MAX_CHARS))}
            onInput={handleTextareaInput}
            onKeyDown={handleKeyDown}
            disabled={isProcessing}
            placeholder={isProcessing ? 'Processing…' : 'Describe your edit…'}
            rows={1}
            style={{
              width:       '100%',
              background:  '#1e1e1e',
              border:      `1px solid ${inputText ? '#00BCD4' : '#333'}`,
              borderRadius: 10,
              padding:     '10px 14px',
              color:       isProcessing ? '#555' : '#ffffff',
              fontSize:    13,
              lineHeight:  1.5,
              resize:      'none',
              outline:     'none',
              minHeight:   44,
              maxHeight:   120,
              fontFamily:  'inherit',
              boxSizing:   'border-box',
              transition:  'border-color 150ms ease',
              display:     'block',
            }}
          />

          {(hasCachedTranscript || hasConversationHistory) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {hasCachedTranscript && (
                <button
                  type="button"
                  disabled={isProcessing}
                  onClick={() => onVisualScan && onVisualScan()}
                  style={{ ...pillBtn, opacity: isProcessing ? 0.45 : 1, display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  onMouseEnter={e => { if (!isProcessing) { e.currentTarget.style.borderColor = 'rgba(45,212,191,0.45)'; e.currentTarget.style.color = '#5EEAD4'; } }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#888'; }}
                >
                  <Image size={12} />
                  Scan for Visuals
                </button>
              )}
              {hasConversationHistory && (
                <React.Fragment>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => onQuickUndoLastEdit && onQuickUndoLastEdit()}
                    style={{ ...pillBtn, opacity: isProcessing ? 0.45 : 1 }}
                    onMouseEnter={e => { if (!isProcessing) { e.currentTarget.style.borderColor = 'rgba(0,188,212,0.35)'; e.currentTarget.style.color = '#bbb'; } }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#888'; }}
                  >
                    Undo last edit
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => onExplainLastChange && onExplainLastChange()}
                    style={{ ...pillBtn, opacity: isProcessing ? 0.45 : 1 }}
                    onMouseEnter={e => { if (!isProcessing) { e.currentTarget.style.borderColor = 'rgba(0,188,212,0.35)'; e.currentTarget.style.color = '#bbb'; } }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#888'; }}
                  >
                    Explain last change
                  </button>
                  <button
                    type="button"
                    disabled={isProcessing}
                    onClick={() => onClearConversationHistory && onClearConversationHistory()}
                    style={{ ...pillBtn, opacity: isProcessing ? 0.45 : 1 }}
                    onMouseEnter={e => { if (!isProcessing) { e.currentTarget.style.borderColor = 'rgba(255,152,0,0.35)'; e.currentTarget.style.color = '#bbb'; } }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = '#888'; }}
                  >
                    Clear history
                  </button>
                </React.Fragment>
              )}
            </div>
          )}

          {/* Action bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select
                value={language}
                onChange={e => setLanguage(e.target.value)}
                style={{ fontSize: 12, background: '#1e1e1e', color: '#888', border: '1px solid #333', borderRadius: 4, padding: '2px 4px' }}
                title="Transcription language"
              >
                <option>Auto</option>
                <option>Turkish</option>
                <option>English</option>
                <option>Spanish</option>
                <option>French</option>
                <option>German</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ color: '#444', fontSize: 11 }}>
                {inputText.length}/{MAX_CHARS}
              </span>
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                title={!currentFile ? 'Load a video first' : !inputText.trim() ? 'Type a prompt' : 'Send'}
                style={{
                  width:          36,
                  height:         36,
                  borderRadius:   8,
                  border:         'none',
                  background:     canSend ? '#00897B' : '#2a2a2a',
                  color:          canSend ? '#ffffff' : '#555',
                  cursor:         canSend ? 'pointer' : 'not-allowed',
                  display:        'flex',
                  alignItems:     'center',
                  justifyContent: 'center',
                  transition:     'background 150ms ease',
                  flexShrink:     0,
                }}
                onMouseEnter={e => { if (canSend) e.currentTarget.style.background = '#00695C'; }}
                onMouseLeave={e => { if (canSend) e.currentTarget.style.background = '#00897B'; }}
              >
                {isProcessing
                  ? <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />
                  : <ArrowUp size={16} />
                }
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Inject spinner keyframes once
  (function injectSpinStyle() {
    const id = 've-spin-style';
    if (!document.getElementById(id)) {
      const s = document.createElement('style');
      s.id = id;
      s.textContent = '@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
      document.head.appendChild(s);
    }
  })();

  window.AgentPanel = AgentPanel;
})();
