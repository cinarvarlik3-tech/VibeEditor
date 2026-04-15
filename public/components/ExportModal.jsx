// ─────────────────────────────────────────────────────────────────────────────
// ExportModal.jsx
// Full-screen modal overlay for configuring and tracking video export.
//
// Props:
//   isOpen       {boolean}
//   job          {object|null}   { jobId, status, progress, filename, error }
//   projectName  {string}
//   onSubmit     {fn}  Called with { format, quality, outputFilename }
//   onClose      {fn}
//
// Sets: window.ExportModal
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  var { useState } = React;
  var { X, Download, CheckCircle, AlertCircle } = window.LucideReact;

  var QUALITY_OPTIONS = [
    { value: '720p',  label: '720p  — HD',         hint: '1280×720'  },
    { value: '1080p', label: '1080p — Full HD',     hint: '1920×1080' },
    { value: '4k',    label: '4K    — Ultra HD',    hint: '3840×2160' },
  ];

  var FORMAT_OPTIONS = [
    { value: 'mp4', label: 'MP4 (H.264)' },
    { value: 'mov', label: 'MOV (ProRes)' },
  ];

  function ExportModal({ isOpen, job, projectName, onSubmit, onClose }) {
    var [format,  setFormat]  = useState('mp4');
    var [quality, setQuality] = useState('1080p');

    if (!isOpen) return null;

    var isRunning = job && (job.status === 'queued' || job.status === 'rendering');
    var isDone    = job && job.status === 'done';
    var isError   = job && job.status === 'error';

    function handleSubmit() {
      if (isRunning) return;
      var safeName    = (projectName || 'export').replace(/[^a-zA-Z0-9_\-]/g, '_');
      var outputFilename = safeName + '_' + quality + '.' + format;
      onSubmit && onSubmit({ format, quality, outputFilename });
    }

    return (
      <div
        style={{
          position:       'fixed',
          inset:          0,
          zIndex:         10000,
          background:     'rgba(0,0,0,0.72)',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
        }}
        onClick={function(e) { if (e.target === e.currentTarget && !isRunning) onClose(); }}
      >
        <div style={{
          background:   '#161616',
          border:       '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10,
          width:        420,
          padding:      '24px',
          boxShadow:    '0 24px 64px rgba(0,0,0,0.8)',
        }}>

          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
            <span style={{ color: '#eee', fontSize: 14, fontWeight: 600 }}>Export Video</span>
            <button
              onClick={onClose}
              disabled={isRunning}
              style={{ background: 'none', border: 'none', color: isRunning ? '#333' : '#666', cursor: isRunning ? 'default' : 'pointer', padding: 4 }}
            >
              <X size={16} />
            </button>
          </div>

          {/* Format selector */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ color: '#888', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Format
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              {FORMAT_OPTIONS.map(function(opt) {
                var active = format === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={function() { if (!isRunning) setFormat(opt.value); }}
                    style={{
                      flex:         1,
                      padding:      '8px 0',
                      background:   active ? 'rgba(0,188,212,0.15)' : '#1e1e1e',
                      border:       active ? '1px solid rgba(0,188,212,0.5)' : '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 5,
                      color:        active ? '#00BCD4' : '#888',
                      fontSize:     12,
                      cursor:       isRunning ? 'default' : 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quality selector */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ color: '#888', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>
              Quality
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              {QUALITY_OPTIONS.map(function(opt) {
                var active = quality === opt.value;
                return (
                  <button
                    key={opt.value}
                    onClick={function() { if (!isRunning) setQuality(opt.value); }}
                    style={{
                      flex:         1,
                      padding:      '8px 4px',
                      background:   active ? 'rgba(0,188,212,0.15)' : '#1e1e1e',
                      border:       active ? '1px solid rgba(0,188,212,0.5)' : '1px solid rgba(255,255,255,0.08)',
                      borderRadius: 5,
                      color:        active ? '#00BCD4' : '#888',
                      fontSize:     11,
                      cursor:       isRunning ? 'default' : 'pointer',
                      textAlign:    'center',
                    }}
                  >
                    <div>{opt.label.split('—')[0].trim()}</div>
                    <div style={{ fontSize: 9, color: active ? 'rgba(0,188,212,0.7)' : '#555', marginTop: 2 }}>{opt.hint}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Correction 2: subtitle/audio notice below quality selector */}
          <div style={{
            background:   'rgba(0,188,212,0.06)',
            border:       '1px solid rgba(0,188,212,0.2)',
            borderRadius: 5,
            padding:      '8px 12px',
            marginBottom: 20,
            color:        'rgba(0,188,212,0.8)',
            fontSize:     11,
            lineHeight:   1.5,
          }}>
            Subtitle overlays and audio track mixing coming in a future update.
          </div>

          {/* Progress bar (shown while running or done) */}
          {job && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ color: '#888', fontSize: 11 }}>
                  {job.status === 'queued'    && 'Queued…'}
                  {job.status === 'rendering' && 'Rendering…'}
                  {job.status === 'done'      && 'Done!'}
                  {job.status === 'error'     && 'Export failed'}
                </span>
                <span style={{ color: '#666', fontSize: 11 }}>{Math.round(job.progress || 0)}%</span>
              </div>
              <div style={{ height: 4, background: '#2a2a2a', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  width:        (job.progress || 0) + '%',
                  height:       '100%',
                  background:   isError ? '#FF6B6B' : '#00BCD4',
                  borderRadius: 2,
                  transition:   'width 300ms ease',
                }} />
              </div>
              {isError && (
                <div style={{ color: '#FF6B6B', fontSize: 11, marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <AlertCircle size={11} />
                  {job.error || 'Unknown error'}
                </div>
              )}
              {isDone && (
                <div style={{ color: '#00BCD4', fontSize: 11, marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle size={11} />
                  Saved as {job.filename}
                  <a
                    href={'/download/' + job.filename}
                    download={job.filename}
                    style={{ color: '#00BCD4', marginLeft: 8, textDecoration: 'underline', fontSize: 11 }}
                  >
                    Download
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              onClick={onClose}
              disabled={isRunning}
              style={{
                padding:      '8px 16px',
                background:   'none',
                border:       '1px solid rgba(255,255,255,0.1)',
                borderRadius: 5,
                color:        isRunning ? '#444' : '#888',
                fontSize:     12,
                cursor:       isRunning ? 'default' : 'pointer',
              }}
            >
              {isDone ? 'Close' : 'Cancel'}
            </button>
            {!isDone && (
              <button
                onClick={handleSubmit}
                disabled={isRunning}
                style={{
                  display:      'flex',
                  alignItems:   'center',
                  gap:          6,
                  padding:      '8px 18px',
                  background:   isRunning ? '#1a4a50' : '#00BCD4',
                  border:       'none',
                  borderRadius: 5,
                  color:        isRunning ? '#aaa' : '#000',
                  fontSize:     12,
                  fontWeight:   600,
                  cursor:       isRunning ? 'default' : 'pointer',
                }}
              >
                <Download size={12} />
                {isRunning ? 'Exporting…' : 'Export'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  window.ExportModal = ExportModal;
})();
