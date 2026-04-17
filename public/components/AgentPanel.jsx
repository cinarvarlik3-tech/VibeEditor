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
  const { ArrowUp, Loader, AlertCircle, Undo2, Redo2, RotateCcw, Wand2, AlertTriangle } = LucideReact;

  // ── Timestamp formatter ──────────────────────────────────────────────────
  function fmtTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ── Message renderers ────────────────────────────────────────────────────

  function UserBubble({ msg }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', marginBottom: 12 }}>
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
    const { summary, prompt, isWarning } = msg.content || {};
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          {warn ? (
            <AlertTriangle size={13} color="#BA7517" style={{ flexShrink: 0 }} />
          ) : (
            <Wand2 size={13} color="#00BCD4" style={{ flexShrink: 0 }} />
          )}
          <span style={{ color: warn ? '#BA7517' : '#00BCD4', fontSize: 12, fontWeight: 600 }}>
            {summary}
          </span>
        </div>
        <div style={{ color: '#555', fontSize: 11, fontStyle: 'italic' }}>
          "{prompt}"
        </div>
      </motion.div>
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
  function AgentPanel({
    messages            = [],
    isProcessing        = false,
    currentFile         = null,
    hasPromptCheckpoint = false,
    onSubmitPrompt,
    onUndo,
    onRedo,
    onUndoLastPrompt,
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
        case 'error':  return <ErrorMessage  key={msg.id} msg={msg} />;
        case 'result': return <ResultMessage key={msg.id} msg={msg} />;
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
          height:         48,
          flexShrink:     0,
          background:     '#111111',
          borderBottom:   '1px solid rgba(255,255,255,0.08)',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          padding:        '0 16px',
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

          {/* Undo Last Prompt button — only shown when a prompt checkpoint exists */}
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
