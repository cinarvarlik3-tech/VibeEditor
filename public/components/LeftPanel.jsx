// ─────────────────────────────────────────────────────────────────────────────
// LeftPanel.jsx
// Left tool panel — Media tab, Details tab, Properties tab.
//
// Tabs:
//   Media       — import files, thumbnail grid, add to timeline
//   Details     — source metadata and project info
//   Properties  — element property editor (shown when an element is selected)
//
// Globals consumed:  React, LucideReact
// Sets global:       window.LeftPanel
// No import / export statements.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  const { useState, useEffect, useRef, useCallback } = React;
  const {
    FolderOpen, Plus, Trash2, Film, Music, Image,
    AlignLeft, Info, Sliders, Upload, Play, Pause,
    Search, X, ChevronRight,
  } = LucideReact;

  // ── Tab bar ────────────────────────────────────────────────────────────────
  function TabBar({ tabs, activeTab, onTabChange }) {
    return (
      <div style={{
        display:     'flex',
        background:  '#111111',
        borderBottom:'1px solid rgba(255,255,255,0.08)',
        flexShrink:  0,
      }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            style={{
              flex:        1,
              height:      40,
              background:  'none',
              border:      'none',
              borderBottom: activeTab === tab.id ? '2px solid #00BCD4' : '2px solid transparent',
              color:       activeTab === tab.id ? '#00BCD4' : '#666',
              fontSize:    11,
              fontWeight:  activeTab === tab.id ? 600 : 400,
              cursor:      'pointer',
              transition:  'color 150ms ease',
              display:     'flex',
              alignItems:  'center',
              justifyContent: 'center',
              gap:         4,
            }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
    );
  }

  // ── Media tab ─────────────────────────────────────────────────────────────
  function MediaTab({ mediaItems, onMediaImport, onMediaRemove, onSetCurrentFile }) {
    const inputRef = useRef(null);

    const handleDrop = useCallback((e) => {
      e.preventDefault();
      const files = e.dataTransfer.files;
      if (files.length > 0) onMediaImport(files);
    }, [onMediaImport]);

    const handleDragOver = useCallback((e) => { e.preventDefault(); }, []);

    function fmtDuration(s) {
      if (!s) return '0:00';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* Import button + drop zone */}
        <div style={{ padding: '12px 12px 8px' }}>
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onClick={() => inputRef.current && inputRef.current.click()}
            style={{
              border:        '1px dashed rgba(255,255,255,0.15)',
              borderRadius:  8,
              padding:       '14px 12px',
              textAlign:     'center',
              cursor:        'pointer',
              color:         '#555',
              fontSize:      12,
              transition:    'border-color 150ms ease',
              background:    'rgba(255,255,255,0.02)',
            }}
            onMouseEnter={e => e.currentTarget.style.borderColor = '#00BCD4'}
            onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'}
          >
            <FolderOpen size={18} color="#444" style={{ marginBottom: 4 }} />
            <div>Drop media here or <span style={{ color: '#00BCD4' }}>browse</span></div>
            <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>MP4, MOV, AVI, WebM · JPG, PNG, GIF, WebP</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="video/*,image/jpeg,image/png,image/gif,image/webp"
            multiple
            style={{ display: 'none' }}
            onChange={e => { if (e.target.files.length > 0) onMediaImport(e.target.files); e.target.value = ''; }}
          />
        </div>

        {/* Media grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
          {mediaItems.length === 0 ? (
            <div style={{ color: '#444', fontSize: 11, textAlign: 'center', marginTop: 20 }}>
              No media imported
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {mediaItems.map(item => (
                <div
                  key={item.id}
                  onClick={() => onSetCurrentFile(item)}
                  style={{
                    display:     'flex',
                    alignItems:  'center',
                    gap:         10,
                    background:  '#1e1e1e',
                    borderRadius: 6,
                    padding:     '8px 10px',
                    cursor:      'pointer',
                    border:      '1px solid rgba(255,255,255,0.06)',
                    transition:  'border-color 150ms ease',
                  }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'rgba(0,188,212,0.4)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'}
                >
                  {/* Thumbnail */}
                  <div style={{
                    width: 48, height: 36, borderRadius: 4, overflow: 'hidden',
                    background: '#111', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    {item.thumbnailUrl
                      ? <img src={item.thumbnailUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
                      : <Film size={16} color="#444" />
                    }
                  </div>
                  {/* Info */}
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{
                      color: '#ccc', fontSize: 12, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {item.filename}
                    </div>
                    <div style={{ color: '#555', fontSize: 10, marginTop: 2 }}>
                      {fmtDuration(item.duration)} · {item.fileSize} · {item.resolution}
                    </div>
                  </div>
                  {/* Remove */}
                  <button
                    onClick={e => { e.stopPropagation(); onMediaRemove(item.id); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#444', padding: 4, flexShrink: 0, display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => e.currentTarget.style.color = '#FF3B30'}
                    onMouseLeave={e => e.currentTarget.style.color = '#444'}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Audio tab ──────────────────────────────────────────────────────────────
  function AudioTab({ onAudioImport, onAddAudioToTimeline }) {
    const fileInputRef    = useRef(null);
    const previewAudioRef = useRef(null);
    const debounceRef     = useRef(null);

    const [searchQuery,   setSearchQuery]   = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isSearching,   setIsSearching]   = useState(false);
    const [uploadedAudio, setUploadedAudio] = useState([]);
    const [activeFilter,  setActiveFilter]  = useState('all');
    const [previewingId,  setPreviewingId]  = useState(null);

    // ── Fetch uploaded audio on mount ──────────────────────────────────────
    useEffect(() => {
      fetch('/api/audio/uploads')
        .then(r => r.json())
        .then(data => setUploadedAudio(data.uploads || []))
        .catch(() => {});
    }, []);

    // ── Search with debounce ───────────────────────────────────────────────
    useEffect(() => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!searchQuery.trim()) {
        setSearchResults([]);
        setIsSearching(false);
        return;
      }
      debounceRef.current = setTimeout(() => {
        setIsSearching(true);
        fetch('/api/audio/search?q=' + encodeURIComponent(searchQuery.trim()))
          .then(r => r.json())
          .then(data => setSearchResults(data.results || []))
          .catch(() => setSearchResults([]))
          .finally(() => setIsSearching(false));
      }, 400);
      return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [searchQuery]);

    // ── Cleanup preview on unmount ─────────────────────────────────────────
    useEffect(() => {
      return () => {
        if (previewAudioRef.current) {
          previewAudioRef.current.pause();
          previewAudioRef.current.src = '';
        }
      };
    }, []);

    // ── Format duration as M:SS ───────────────────────────────────────────
    function fmtDur(s) {
      if (!s && s !== 0) return '';
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return m + ':' + String(sec).padStart(2, '0');
    }

    // ── Toggle preview playback ───────────────────────────────────────────
    function handlePreview(item) {
      if (previewingId === item.id) {
        if (previewAudioRef.current) previewAudioRef.current.pause();
        setPreviewingId(null);
        return;
      }
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current.src = '';
      }
      const audio = new Audio(item.previewUrl || item.url);
      audio.volume = 0.8;
      audio.play().catch(() => {});
      audio.onended = () => setPreviewingId(null);
      previewAudioRef.current = audio;
      setPreviewingId(item.id);
    }

    // ── Handle file upload ─────────────────────────────────────────────────
    function handleFileSelect(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      e.target.value = '';
      onAudioImport && onAudioImport(file);
      // Re-fetch uploads list after a brief delay for the server to process
      setTimeout(() => {
        fetch('/api/audio/uploads')
          .then(r => r.json())
          .then(data => setUploadedAudio(data.uploads || []))
          .catch(() => {});
      }, 800);
    }

    // ── Merge and filter results ───────────────────────────────────────────
    const uploadItems = uploadedAudio.map(u => ({
      id:         'upload-' + u.filename,
      name:       u.name || u.filename,
      filename:   u.filename,
      duration:   null,
      previewUrl: u.url,
      url:        u.url,
      source:     'upload',
      sourceType: 'upload',
      fileSize:   u.fileSize,
    }));

    // Client-side filter uploads by query
    const filteredUploads = searchQuery.trim()
      ? uploadItems.filter(u =>
          u.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
        )
      : uploadItems;

    const allResults = [
      ...filteredUploads,
      ...searchResults.map(r => ({ ...r, sourceType: r.source })),
    ];

    const displayResults = activeFilter === 'all'
      ? allResults
      : allResults.filter(r => r.sourceType === activeFilter);

    // ── Source badge style ─────────────────────────────────────────────────
    const SOURCE_BADGE = {
      upload:    { label: 'UPLOAD',   bg: 'rgba(0,137,123,0.2)',   color: '#00897B' },
      freesound: { label: 'FREESOUND', bg: 'rgba(21,101,192,0.2)', color: '#1E88E5' },
      jamendo:   { label: 'JAMENDO',  bg: 'rgba(230,81,0,0.2)',    color: '#FF6E40' },
    };

    const FILTERS = ['all', 'uploads', 'freesound', 'jamendo'];

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* ── Action bar ─────────────────────────────────────────────────── */}
        <div style={{
          display:    'flex',
          alignItems: 'center',
          gap:        8,
          padding:    '10px 12px',
          flexShrink: 0,
        }}>
          {/* Upload button */}
          <button
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          4,
              background:   'transparent',
              border:       '1px solid #00BCD4',
              borderRadius: 5,
              color:        '#00BCD4',
              fontSize:     11,
              fontWeight:   600,
              padding:      '5px 10px',
              cursor:       'pointer',
              flexShrink:   0,
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(0,188,212,0.08)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <Upload size={12} />
            Upload
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          {/* Search input */}
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={11} color="#555" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search sounds and music…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                width:        '100%',
                background:   '#1e1e1e',
                border:       '1px solid #333',
                borderRadius: 6,
                padding:      '5px 28px 5px 26px',
                color:        '#fff',
                fontSize:     12,
                outline:      'none',
                boxSizing:    'border-box',
              }}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#555', display: 'flex', padding: 2 }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>

        {/* ── Source filter tabs ──────────────────────────────────────────── */}
        <div style={{
          display:      'flex',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink:   0,
          padding:      '0 12px',
        }}>
          {FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setActiveFilter(f)}
              style={{
                background:   'none',
                border:       'none',
                borderBottom: activeFilter === f ? '2px solid #00BCD4' : '2px solid transparent',
                color:        activeFilter === f ? '#00BCD4' : '#555',
                fontSize:     10,
                fontWeight:   activeFilter === f ? 600 : 400,
                padding:      '5px 8px',
                cursor:       'pointer',
                textTransform: 'uppercase',
                letterSpacing: 0.4,
              }}
            >
              {f === 'all' ? 'All' : f === 'uploads' ? 'Uploads' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* ── Results list ───────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>

          {/* Loading skeletons */}
          {isSearching && [0,1,2].map(i => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', height: 56 }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#252525', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ width: '60%', height: 10, borderRadius: 4, background: '#252525', marginBottom: 6 }} />
                <div style={{ width: '35%', height: 8,  borderRadius: 4, background: '#222' }} />
              </div>
            </div>
          ))}

          {/* Empty — no query, no uploads */}
          {!isSearching && displayResults.length === 0 && !searchQuery && (
            <div style={{ textAlign: 'center', padding: '30px 16px', color: '#555' }}>
              <Music size={24} color="#333" style={{ marginBottom: 8 }} />
              <div style={{ fontSize: 12 }}>Search for sounds or upload your own</div>
            </div>
          )}

          {/* Empty — query returned nothing */}
          {!isSearching && displayResults.length === 0 && searchQuery && (
            <div style={{ textAlign: 'center', padding: '30px 16px', color: '#555', fontSize: 12 }}>
              No results for "{searchQuery}"
            </div>
          )}

          {/* Result rows */}
          {!isSearching && displayResults.map(item => {
            const badge     = SOURCE_BADGE[item.sourceType] || SOURCE_BADGE.upload;
            const isPrev    = previewingId === item.id;
            const audioItem = {
              src:        item.url || item.previewUrl,
              sourceName: item.name,
              sourceType: item.sourceType,
              duration:   item.duration,
            };
            return (
              <div
                key={item.id}
                style={{
                  display:     'flex',
                  alignItems:  'center',
                  gap:         10,
                  padding:     '8px 12px',
                  height:      56,
                  cursor:      'default',
                  transition:  'background 100ms ease',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.04)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {/* Play/pause button */}
                <button
                  onClick={() => handlePreview(item)}
                  title={isPrev ? 'Pause preview' : 'Preview'}
                  style={{
                    width:          32,
                    height:         32,
                    borderRadius:   '50%',
                    background:     isPrev ? '#00897B' : 'rgba(255,255,255,0.08)',
                    border:         'none',
                    cursor:         'pointer',
                    display:        'flex',
                    alignItems:     'center',
                    justifyContent: 'center',
                    flexShrink:     0,
                    color:          '#fff',
                    transition:     'background 150ms ease',
                  }}
                >
                  {isPrev ? <Pause size={13} fill="#fff" /> : <Play size={13} fill="#fff" />}
                </button>

                {/* Info */}
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{
                    color:        '#ccc',
                    fontSize:     12,
                    overflow:     'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace:   'nowrap',
                    marginBottom: 3,
                  }}>
                    {item.name}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {item.duration ? (
                      <span style={{ color: '#666', fontSize: 10 }}>{fmtDur(item.duration)}</span>
                    ) : null}
                    <span style={{
                      fontSize:     9,
                      fontWeight:   700,
                      letterSpacing: 0.4,
                      padding:      '1px 5px',
                      borderRadius: 3,
                      background:   badge.bg,
                      color:        badge.color,
                    }}>
                      {badge.label}
                    </span>
                  </div>
                </div>

                {/* Add button */}
                <button
                  onClick={() => onAddAudioToTimeline && onAddAudioToTimeline(audioItem)}
                  title="Add to timeline"
                  style={{
                    background:     'none',
                    border:         'none',
                    cursor:         'pointer',
                    color:          '#555',
                    display:        'flex',
                    alignItems:     'center',
                    justifyContent: 'center',
                    padding:        4,
                    flexShrink:     0,
                    transition:     'color 100ms ease',
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                  onMouseLeave={e => e.currentTarget.style.color = '#555'}
                >
                  <Plus size={16} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Details tab ────────────────────────────────────────────────────────────
  function DetailsTab({ source, project }) {
    function Row({ label, value }) {
      return (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <span style={{ color: '#666', fontSize: 11 }}>{label}</span>
          <span style={{ color: '#ccc', fontSize: 11, textAlign: 'right', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {value || '—'}
          </span>
        </div>
      );
    }

    function fmtDuration(s) {
      if (!s) return '—';
      const m = Math.floor(s / 60);
      const sec = (s % 60).toFixed(1);
      return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')} (${s.toFixed(1)}s)`;
    }

    function fmtSize(bytes) {
      if (!bytes) return '—';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    return (
      <div style={{ padding: '12px 16px', overflowY: 'auto', height: '100%' }}>
        {/* Project */}
        <div style={{ color: '#00BCD4', fontSize: 10, fontWeight: 600, letterSpacing: 1, marginBottom: 8, marginTop: 4 }}>PROJECT</div>
        <Row label="Name"     value={project && project.name}      />
        <Row label="ID"       value={project && project.id}        />
        <Row label="Created"  value={project && project.createdAt ? new Date(project.createdAt).toLocaleString() : null} />
        <Row label="Modified" value={project && project.updatedAt ? new Date(project.updatedAt).toLocaleString() : null} />

        {/* Source */}
        <div style={{ color: '#00BCD4', fontSize: 10, fontWeight: 600, letterSpacing: 1, marginBottom: 8, marginTop: 16 }}>SOURCE</div>
        <Row label="File"       value={source && source.filename}                  />
        <Row label="Duration"   value={source && source.duration ? fmtDuration(source.duration) : null} />
        <Row label="Resolution" value={source && source.width ? `${source.width}×${source.height}` : null} />
        <Row label="FPS"        value={source && source.fps ? source.fps + ' fps' : null} />
        <Row label="File size"  value={source && source.fileSize ? fmtSize(source.fileSize) : null} />
      </div>
    );
  }

  // ── Shared helpers (module scope — stable identity across renders) ──────────

  function inputStyle(width) {
    return {
      background: '#1e1e1e', border: '1px solid #333', borderRadius: 4,
      color: '#fff', fontSize: 12, padding: '5px 8px', width: width || '100%',
      outline: 'none', boxSizing: 'border-box',
    };
  }

  function PropRow({ label, children }) {
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ color: '#666', fontSize: 10, marginBottom: 4, letterSpacing: 0.5 }}>{label}</div>
        {children}
      </div>
    );
  }

  // ── SubtitleProps (module scope) ───────────────────────────────────────────
  function SubtitleProps({ element, elementId, update, onPreviewPosition }) {
    const [localX, setLocalX] = useState(
      typeof element.position.x === 'number' ? element.position.x : 0
    );
    const [localY, setLocalY] = useState(
      typeof element.position.y === 'number' ? element.position.y : 0
    );

    // Sync local state when switching to a different element
    useEffect(() => {
      setLocalX(typeof element.position.x === 'number' ? element.position.x : 0);
      setLocalY(typeof element.position.y === 'number' ? element.position.y : 0);
    }, [elementId]);

    // Drive VideoPreview in real-time while typing (no undo entry)
    useEffect(() => {
      onPreviewPosition && onPreviewPosition({ elementId, x: localX, y: localY });
    }, [localX, localY]);

    return (
      <div>
        <PropRow label="TEXT">
          <textarea
            defaultValue={element.text}
            onBlur={e => update('text', e.target.value)}
            style={{ ...inputStyle(), resize: 'vertical', minHeight: 60, fontFamily: 'inherit' }}
          />
        </PropRow>
        <div style={{ display: 'flex', gap: 8 }}>
          <PropRow label="COLOR">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="color"
                defaultValue={element.style.color || '#ffffff'}
                onChange={e => update('style.color', e.target.value)}
                style={{ width: 32, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
              />
              <input
                type="text"
                defaultValue={element.style.color || '#ffffff'}
                onBlur={e => update('style.color', e.target.value)}
                style={{ ...inputStyle(), width: 80 }}
              />
            </div>
          </PropRow>
          <PropRow label="FONT SIZE">
            <input
              type="number"
              defaultValue={element.style.fontSize || 52}
              min={10} max={200}
              onBlur={e => update('style.fontSize', Number(e.target.value))}
              style={inputStyle(70)}
            />
          </PropRow>
        </div>
        <PropRow label="FONT FAMILY">
          <select
            defaultValue={element.style.fontFamily || 'Arial'}
            onChange={e => update('style.fontFamily', e.target.value)}
            style={{ ...inputStyle(), cursor: 'pointer' }}
          >
            {['Arial', 'Georgia', 'Impact', 'Courier New', 'Trebuchet MS', 'Verdana', 'Times New Roman'].map(f => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
        </PropRow>
        <div style={{ display: 'flex', gap: 8 }}>
          <PropRow label="WEIGHT">
            <select defaultValue={element.style.fontWeight || 'normal'} onChange={e => update('style.fontWeight', e.target.value)} style={{ ...inputStyle(), cursor: 'pointer' }}>
              <option value="normal">Normal</option>
              <option value="bold">Bold</option>
            </select>
          </PropRow>
          <PropRow label="STYLE">
            <select defaultValue={element.style.fontStyle || 'normal'} onChange={e => update('style.fontStyle', e.target.value)} style={{ ...inputStyle(), cursor: 'pointer' }}>
              <option value="normal">Normal</option>
              <option value="italic">Italic</option>
            </select>
          </PropRow>
        </div>
        <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.06)', margin: '6px 0 12px' }} />
        <PropRow label="EFFECT">
          <select
            value={(element.style.effect && element.style.effect.type) || 'none'}
            onChange={e => {
              const type = e.target.value;
              const defaults = { none: null, outline: '#000000', shadow: '#000000', glow: '#ff00ff', textBox: '#000000' };
              update('style.effect.type', type);
              if (type !== 'none') {
                update('style.effect.color', defaults[type]);
              }
            }}
            style={{ ...inputStyle(), cursor: 'pointer' }}
          >
            <option value="none">None</option>
            <option value="outline">Outline</option>
            <option value="shadow">Shadow</option>
            <option value="glow">Neon Glow</option>
            <option value="textBox">Text Box</option>
          </select>
        </PropRow>
        {element.style.effect && element.style.effect.type && element.style.effect.type !== 'none' && (
          <PropRow label={
            element.style.effect.type === 'outline' ? 'OUTLINE COLOR' :
            element.style.effect.type === 'shadow'  ? 'SHADOW COLOR' :
            element.style.effect.type === 'glow'    ? 'GLOW COLOR' :
            element.style.effect.type === 'textBox' ? 'BOX COLOR' :
            'EFFECT COLOR'
          }>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="color"
                value={(element.style.effect && element.style.effect.color) || '#000000'}
                onChange={e => update('style.effect.color', e.target.value)}
                style={{ width: 32, height: 28, border: 'none', borderRadius: 4, cursor: 'pointer', background: 'none' }}
              />
              <input
                type="text"
                value={(element.style.effect && element.style.effect.color) || '#000000'}
                onChange={e => update('style.effect.color', e.target.value)}
                style={{ ...inputStyle(), width: 80 }}
              />
            </div>
          </PropRow>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <PropRow label="POSITION X">
            <input
              type="number"
              min={-540} max={540}
              value={localX}
              onChange={e => setLocalX(Number(e.target.value))}
              onBlur={e => update('position.x', Number(e.target.value))}
              style={inputStyle(80)}
            />
          </PropRow>
          <PropRow label="POSITION Y">
            <input
              type="number"
              min={-960} max={960}
              value={localY}
              onChange={e => setLocalY(Number(e.target.value))}
              onBlur={e => update('position.y', Number(e.target.value))}
              style={inputStyle(80)}
            />
          </PropRow>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <PropRow label="ANIM IN">
            <select defaultValue={element.animation && element.animation.in ? element.animation.in.type : 'none'} onChange={e => update('animation.in.type', e.target.value)} style={{ ...inputStyle(), cursor: 'pointer' }}>
              {['none','fade','slideUp','slideDown','pop','typewriter','wordByWord'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </PropRow>
          <PropRow label="ANIM OUT">
            <select defaultValue={element.animation && element.animation.out ? element.animation.out.type : 'none'} onChange={e => update('animation.out.type', e.target.value)} style={{ ...inputStyle(), cursor: 'pointer' }}>
              {['none','fade','slideUp','slideDown','pop'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </PropRow>
        </div>
      </div>
    );
  }

  // ── VideoClipProps (module scope) ──────────────────────────────────────────
  // Shows clip-level speed, volume, and source cut-point controls.
  // Scale and opacity are keyframe-animated — select a diamond on the timeline.
  function VideoClipProps({ element, elementId, update }) {
    const playbackRate = element.playbackRate !== undefined ? element.playbackRate : 1.0;
    const volume       = element.volume       !== undefined ? element.volume       : 1.0;

    return (
      <div>

        {/* Filename / image badge */}
        {element.originalFilename && (
          <PropRow label="FILE">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {element.isImage && (
                <span style={{
                  fontSize: 9, fontWeight: 700, color: '#00BCD4',
                  background: 'rgba(0,188,212,0.12)', borderRadius: 2,
                  padding: '1px 4px', flexShrink: 0,
                }}>
                  IMG
                </span>
              )}
              <span style={{
                color: '#aaa', fontSize: 11,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {element.originalFilename}
              </span>
            </div>
          </PropRow>
        )}
        {/* Playback rate slider */}
        <PropRow label="SPEED">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={0.25} max={4} step={0.25}
              value={playbackRate}
              onChange={e => update('playbackRate', Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ color: '#888', fontSize: 11, minWidth: 32, textAlign: 'right' }}>
              {playbackRate.toFixed(2)}x
            </span>
          </div>
        </PropRow>

        {/* Volume slider */}
        <PropRow label="VOLUME">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={0} max={1} step={0.05}
              value={volume}
              onChange={e => update('volume', Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ color: '#888', fontSize: 11, minWidth: 32, textAlign: 'right' }}>
              {Math.round(volume * 100)}%
            </span>
          </div>
        </PropRow>

        {/* Source cut points */}
        <div style={{ display: 'flex', gap: 8 }}>
          <PropRow label="SOURCE IN (s)">
            <input
              type="number" step={0.1} min={0}
              defaultValue={(element.sourceStart || 0).toFixed(2)}
              key={elementId + '_srcStart'}
              onBlur={e => update('sourceStart', Number(e.target.value))}
              style={inputStyle(80)}
            />
          </PropRow>
          <PropRow label="SOURCE OUT (s)">
            <input
              type="number" step={0.1} min={0}
              defaultValue={(element.sourceEnd || 0).toFixed(2)}
              key={elementId + '_srcEnd'}
              onBlur={e => update('sourceEnd', Number(e.target.value))}
              style={inputStyle(80)}
            />
          </PropRow>
        </div>

        <div style={{
          background:   'rgba(0,188,212,0.05)',
          border:       '1px solid rgba(0,188,212,0.12)',
          borderRadius: 4,
          padding:      '5px 9px',
          marginTop:    10,
          color:        '#555',
          fontSize:     10,
          lineHeight:   1.5,
        }}>
          Scale &amp; opacity are keyframe-animated — click the clip on the timeline to add keyframes.
        </div>
      </div>
    );
  }

  // ── KeyframeProps (module scope) ───────────────────────────────────────────
  // Shown in PropertiesTab when a keyframe diamond is selected.
  // Displays and edits the value, time, and easing of the selected keyframe.
  function KeyframeProps({ element, selectedKeyframe, onUpdateKeyframe, onDeleteKeyframe }) {
    if (!selectedKeyframe || !element || !element.keyframes) return null;
    const { elementId, trackName, index } = selectedKeyframe;
    const kfArray = element.keyframes[trackName];
    if (!kfArray || index < 0 || index >= kfArray.length) return null;
    const kf = kfArray[index];

    // Track-specific input config
    const trackConfig = {
      scale:   { label: 'SCALE',   min: 0.5,    max: 5.0,  step: 0.01,  fmt: v => Math.round(v * 100) + '%' },
      speed:   { label: 'SPEED',   min: 0.0625, max: 16.0, step: 0.25,  fmt: v => v.toFixed(2) + 'x'       },
      volume:  { label: 'VOLUME',  min: 0,      max: 1.0,  step: 0.01,  fmt: v => Math.round(v * 100) + '%' },
      opacity: { label: 'OPACITY', min: 0,      max: 1.0,  step: 0.01,  fmt: v => Math.round(v * 100) + '%' },
    };
    const cfg = trackConfig[trackName] || trackConfig.scale;
    const clipDuration = (element.endTime || 0) - (element.startTime || 0);

    const EASING_OPTIONS = [
      { value: 'linear',      label: 'Linear'      },
      { value: 'ease-in',     label: 'Ease In'     },
      { value: 'ease-out',    label: 'Ease Out'    },
      { value: 'ease-in-out', label: 'Ease In-Out' },
      { value: 'hold',        label: 'Hold'        },
    ];

    function doUpdate(changes) {
      onUpdateKeyframe && onUpdateKeyframe(elementId, trackName, index, changes);
    }

    return (
      <div style={{
        background:   'rgba(0,188,212,0.06)',
        border:       '1px solid rgba(0,188,212,0.2)',
        borderRadius: 6,
        padding:      '10px 12px',
        marginBottom: 14,
      }}>
        <div style={{ color: '#00BCD4', fontSize: 10, fontWeight: 600, letterSpacing: 0.5, marginBottom: 10 }}>
          {cfg.label} KEYFRAME @ {kf.time.toFixed(2)}s
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <PropRow label={cfg.label}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="number"
                min={cfg.min} max={cfg.max} step={cfg.step}
                defaultValue={kf.value}
                key={elementId + '_' + trackName + '_' + index + '_value'}
                onBlur={e => doUpdate({ value: Number(e.target.value) })}
                style={inputStyle(70)}
              />
              <span style={{ color: '#666', fontSize: 10 }}>{cfg.fmt(kf.value)}</span>
            </div>
          </PropRow>
          <PropRow label="TIME (s)">
            <input
              type="number"
              min={0} max={clipDuration} step={0.1}
              defaultValue={kf.time.toFixed(2)}
              key={elementId + '_' + trackName + '_' + index + '_time'}
              onBlur={e => doUpdate({ time: Number(e.target.value) })}
              style={inputStyle(70)}
            />
          </PropRow>
        </div>

        <PropRow label="EASING">
          <select
            value={kf.easing || 'linear'}
            onChange={e => doUpdate({ easing: e.target.value })}
            style={{ ...inputStyle(), cursor: 'pointer' }}
          >
            {EASING_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </PropRow>

        <button
          onClick={() => onDeleteKeyframe && onDeleteKeyframe(elementId, trackName, index)}
          style={{
            background:   'none',
            border:       'none',
            color:        '#FF3B30',
            fontSize:     11,
            cursor:       'pointer',
            padding:      '2px 0',
            marginTop:    2,
          }}
        >
          Delete keyframe
        </button>
      </div>
    );
  }

  // ── AudioClipProps (module scope) ─────────────────────────────────────────
  function AudioClipProps({ element, elementId, update }) {
    const SOURCE_BADGE = {
      upload:    { label: 'UPLOAD',    bg: 'rgba(0,137,123,0.2)',  color: '#00897B' },
      freesound: { label: 'FREESOUND', bg: 'rgba(21,101,192,0.2)', color: '#1E88E5' },
      jamendo:   { label: 'JAMENDO',  bg: 'rgba(230,81,0,0.2)',   color: '#FF6E40' },
    };
    const badge = SOURCE_BADGE[element.sourceType] || SOURCE_BADGE.upload;
    const vol   = element.volume !== undefined ? element.volume : 1;

    return (
      <div>
        {/* Name (read-only) */}
        <PropRow label="NAME">
          <div style={{
            color: '#ccc', fontSize: 12, padding: '5px 0',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {element.sourceName || 'Audio'}
          </div>
        </PropRow>

        {/* Source badge (read-only) */}
        <PropRow label="SOURCE">
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
            padding: '2px 6px', borderRadius: 3,
            background: badge.bg, color: badge.color,
          }}>
            {badge.label}
          </span>
        </PropRow>

        {/* Volume slider */}
        <PropRow label="VOLUME">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={0} max={1} step={0.01}
              defaultValue={vol}
              onMouseUp={e => update('volume', Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span style={{ color: '#888', fontSize: 11, minWidth: 32 }}>
              {Math.round(vol * 100)}%
            </span>
          </div>
        </PropRow>

        {/* Fade In / Fade Out */}
        <div style={{ display: 'flex', gap: 8 }}>
          <PropRow label="FADE IN">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number" min={0} max={30} step={0.1}
                defaultValue={(element.fadeIn || 0).toFixed(1)}
                onBlur={e => update('fadeIn', Number(e.target.value))}
                style={{ ...inputStyle(60) }}
              />
              <span style={{ color: '#666', fontSize: 10 }}>s</span>
            </div>
          </PropRow>
          <PropRow label="FADE OUT">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="number" min={0} max={30} step={0.1}
                defaultValue={(element.fadeOut || 0).toFixed(1)}
                onBlur={e => update('fadeOut', Number(e.target.value))}
                style={{ ...inputStyle(60) }}
              />
              <span style={{ color: '#666', fontSize: 10 }}>s</span>
            </div>
          </PropRow>
        </div>
      </div>
    );
  }

  // ── Properties tab ─────────────────────────────────────────────────────────
  function PropertiesTab({ element, elementId, onUpdateElement, onDeleteElement, onPreviewPosition,
                           selectedKeyframe, onUpdateKeyframe, onDeleteKeyframe }) {
    if (!element) {
      return (
        <div style={{ padding: 16, color: '#444', fontSize: 12, textAlign: 'center', marginTop: 20 }}>
          Select an element on the timeline to edit its properties.
        </div>
      );
    }

    // Pre-bind elementId so sub-components call update('field', value) cleanly
    function update(dotPath, value) {
      onUpdateElement({ elementId, changes: { [dotPath]: value } });
    }

    return (
      <div style={{ padding: '12px 16px', overflowY: 'auto', height: '100%' }}>

        {/* Element type badge + delete button */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{
            background:   'rgba(0,188,212,0.12)',
            border:       '1px solid rgba(0,188,212,0.3)',
            borderRadius: 4,
            color:        '#00BCD4',
            fontSize:     10,
            fontWeight:   600,
            padding:      '3px 8px',
            letterSpacing: 0.5,
            textTransform: 'uppercase',
          }}>
            {element.type}
          </span>
          <button
            onClick={() => onDeleteElement(elementId)}
            style={{
              background: 'none', border: '1px solid rgba(255,59,48,0.3)', borderRadius: 4,
              color: '#FF3B30', fontSize: 11, cursor: 'pointer', padding: '3px 8px',
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <Trash2 size={11} /> Delete
          </button>
        </div>

        {/* Timing row */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <div>
            <div style={{ color: '#666', fontSize: 10, marginBottom: 4 }}>START (s)</div>
            <input type="number" step={0.1} min={0} defaultValue={element.startTime.toFixed(2)} onBlur={e => update('startTime', Number(e.target.value))} style={{ ...inputStyle(80) }} />
          </div>
          <div>
            <div style={{ color: '#666', fontSize: 10, marginBottom: 4 }}>END (s)</div>
            <input type="number" step={0.1} min={0} defaultValue={element.endTime.toFixed(2)} onBlur={e => update('endTime', Number(e.target.value))} style={{ ...inputStyle(80) }} />
          </div>
        </div>

        <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.06)', marginBottom: 14 }} />

        {/* Keyframe props — shown above element props when a diamond is selected */}
        {element.type === 'videoClip' && selectedKeyframe && selectedKeyframe.elementId === elementId && (
          <KeyframeProps
            element={element}
            selectedKeyframe={selectedKeyframe}
            onUpdateKeyframe={onUpdateKeyframe}
            onDeleteKeyframe={onDeleteKeyframe}
          />
        )}

        {/* Type-specific props — all components are module-scope, stable identity */}
        {element.type === 'subtitle'  && <SubtitleProps  element={element} elementId={elementId} update={update} onPreviewPosition={onPreviewPosition} />}
        {element.type === 'videoClip' && <VideoClipProps element={element} elementId={elementId} update={update} />}
        {element.type === 'audioClip' && <AudioClipProps element={element} elementId={elementId} update={update} />}
      </div>
    );
  }

  // ── Main LeftPanel ─────────────────────────────────────────────────────────
  function LeftPanel({
    mediaItems           = [],
    source               = null,
    project              = null,
    selectedElement      = null,
    selectedElementId    = null,
    selectedKeyframe     = null,
    audioFiles           = [],
    onMediaImport,
    onMediaRemove,
    onSetCurrentFile,
    onUpdateElement,
    onDeleteElement,
    onPreviewPosition,
    onAudioImport,
    onAddAudioToTimeline,
    onUpdateKeyframe,
    onDeleteKeyframe,
  }) {
    // Auto-switch to Properties tab when an element is selected
    const [activeTab, setActiveTab] = useState('media');

    // When selectedElement changes to a non-null value, open Properties
    const prevElementId = useRef(null);
    if (selectedElementId !== prevElementId.current) {
      prevElementId.current = selectedElementId;
      if (selectedElementId && activeTab !== 'properties') {
        setActiveTab('properties');
      }
    }

    const tabs = [
      { id: 'media',      label: 'Media',      icon: <Film size={12} />    },
      { id: 'audio',      label: 'Audio',      icon: <Music size={12} />   },
      { id: 'details',    label: 'Details',    icon: <Info size={12} />    },
      { id: 'properties', label: 'Properties', icon: <Sliders size={12} /> },
    ];

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#161616' }}>

        {/* Top bar */}
        <div style={{
          height:         48,
          flexShrink:     0,
          background:     '#111111',
          borderBottom:   '1px solid rgba(255,255,255,0.08)',
          display:        'flex',
          alignItems:     'center',
          padding:        '0 16px',
        }}>
          <span style={{ color: '#888', fontSize: 13, fontWeight: 500 }}>Library</span>
        </div>

        {/* Tab bar */}
        <TabBar tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

        {/* Tab content */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {activeTab === 'media' && (
            <MediaTab
              mediaItems={mediaItems}
              onMediaImport={onMediaImport}
              onMediaRemove={onMediaRemove}
              onSetCurrentFile={onSetCurrentFile}
            />
          )}
          {activeTab === 'audio' && (
            <AudioTab
              onAudioImport={onAudioImport}
              onAddAudioToTimeline={onAddAudioToTimeline}
            />
          )}
          {activeTab === 'details' && (
            <DetailsTab source={source} project={project} />
          )}
          {activeTab === 'properties' && (
            <PropertiesTab
              element={selectedElement}
              elementId={selectedElementId}
              onUpdateElement={onUpdateElement}
              onDeleteElement={onDeleteElement}
              onPreviewPosition={onPreviewPosition}
              selectedKeyframe={selectedKeyframe}
              onUpdateKeyframe={onUpdateKeyframe}
              onDeleteKeyframe={onDeleteKeyframe}
            />
          )}
        </div>
      </div>
    );
  }

  window.LeftPanel = LeftPanel;
})();
