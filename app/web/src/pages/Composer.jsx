import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../data/store.jsx";
import { ME } from "../data/identities.js";
import { entity, nameOf, senderName } from "../state/selectors.js";
import { Avatar, Btn, IconBtn } from "../ui/primitives.jsx";
import { useSendFiles } from "./useSendFiles.js";
import { Smile, Image, Paperclip, AtSign, X } from "../icons.js";

const EMOJI = {
  "表情": ["😀","😄","😁","😊","🥰","😍","🤩","😎","🤔","🤗","😂","🤣","🥹","😅","😉","😋","😴","😭","😮","😱","😤","🥳","🫡","🤖"],
  "手势与心情": ["👍","👎","👏","🙌","🤝","🙏","👌","✌️","👋","💪","❤️","🧡","💛","💚","💙","💜","🩷","💕","💯","✨","🎉","🎊","💡","✅"],
  "生活与出行": ["☀️","🌈","🌸","🌊","🌿","🍀","🐱","🐶","☕","🍵","🍰","🍜","🍱","🍕","🎂","🎁","📷","🎵","📚","💻","🚆","✈️","🏖️","🗺️"],
};

/** The service's limit for a message's text, in characters (code points) after trimming. */
export const TEXT_LIMIT = 8000;
/** Typing pauses this long before the draft is written to the data layer (and at once on leaving the chat). */
const DRAFT_SAVE_MS = 300;

export function Composer({ conv, block, replyTo, setReplyTo }) {
  const { state, actions } = useStore();
  const [text, setText] = useState(() => state.drafts?.[conv.id] ?? "");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [category, setCategory] = useState("表情");
  const [mention, setMention] = useState(null);
  const [active, setActive] = useState(0);
  const [height, setHeight] = useState(64);
  const inputRef = useRef(null);
  const imagePicker = useRef(null);
  const filePicker = useRef(null);
  const rootRef = useRef(null);
  const selection = useRef({ start: 0, end: 0 });
  const drag = useRef(null);
  const unsaved = useRef(null);
  const disabled = Boolean(block);
  const length = [...text.trim()].length;
  const tooLong = length > TEXT_LIMIT;
  // @ suggestions: the conversation's current members, nobody else.
  const people = conv.members.filter(id => id !== ME);
  const matches = mention ? people.filter(id => `${nameOf(state,id)} ${entity(state,id)?.handle || ""}`.toLowerCase().includes(mention.query.toLowerCase())) : [];
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  const maxHeight = () => Math.max(64, Math.min(360, Math.floor(window.innerHeight * 0.42)));
  const clampHeight = value => Math.max(56, Math.min(maxHeight(), value));

  // Drafts live in the data layer per conversation: written after a pause, and at once when the chat changes or closes.
  const saveDraft = useCallback(() => {
    const draft = unsaved.current;
    if (!draft) return;
    clearTimeout(draft.timer);
    unsaved.current = null;
    actions.setDraft(draft.convId, draft.text);
  }, [actions]);
  const edit = value => {
    setText(value);
    if (unsaved.current) clearTimeout(unsaved.current.timer);
    unsaved.current = { convId: conv.id, text: value, timer: setTimeout(saveDraft, DRAFT_SAVE_MS) };
  };
  useEffect(() => saveDraft, [conv.id, saveDraft]);

  useEffect(() => { setText(state.drafts?.[conv.id] ?? ""); setMention(null); setEmojiOpen(false); selection.current={start:0,end:0}; setReplyTo(null); }, [conv.id]);
  useEffect(() => { if (replyTo) inputRef.current?.focus(); }, [replyTo]);
  useEffect(() => { if(disabled) { setEmojiOpen(false); setMention(null); } }, [disabled]);
  useEffect(() => {
    const close = e => { if (!rootRef.current?.contains(e.target)) { setEmojiOpen(false); setMention(null); } };
    document.addEventListener("pointerdown",close);
    return () => document.removeEventListener("pointerdown",close);
  },[]);
  useEffect(() => { rootRef.current?.querySelector('[role="option"][aria-selected="true"]')?.scrollIntoView({block:"nearest"}); },[selected, mention?.query]);

  const detect = (value, start, end = start) => {
    selection.current = {start,end};
    const found = start === end && value.slice(0,start).match(/(?:^|\s)@([^\s@]*)$/u);
    if (found) { setMention({start:start-found[1].length-1,end:start,query:found[1]}); setActive(0); setEmojiOpen(false); }
    else setMention(null);
  };
  const replace = (snippet, range=selection.current) => {
    if(disabled) return;
    const value = text.slice(0,range.start)+snippet+text.slice(range.end);
    const cursor = range.start+snippet.length;
    edit(value); setMention(null); setEmojiOpen(false);
    selection.current={start:cursor,end:cursor};
    requestAnimationFrame(()=>{ inputRef.current?.focus(); inputRef.current?.setSelectionRange(cursor,cursor); });
  };
  const chooseMention = id => replace(`@${nameOf(state,id)} `,mention);
  const openMentions = () => {
    if (mention) { setMention(null); return; }
    const range=selection.current;
    const prefix = range.start > 0 && !/\s/.test(text[range.start-1]) ? " @" : "@";
    const value=text.slice(0,range.start)+prefix+text.slice(range.end);
    const cursor=range.start+prefix.length;
    edit(value); detect(value,cursor); setEmojiOpen(false);
    requestAnimationFrame(()=>{inputRef.current?.focus();inputRef.current?.setSelectionRange(cursor,cursor);});
  };
  const send = () => {
    const body=text.trim();
    if(!body || disabled || tooLong) return;
    actions.sendText(conv.id, body, { replyToSeq: replyTo?.seq ?? null });
    edit(""); saveDraft();
    selection.current={start:0,end:0};
    setReplyTo(null);setMention(null);setEmojiOpen(false);
  };
  const keyDown = e => {
    if(e.nativeEvent.isComposing || e.keyCode===229) return;
    if(e.key==="Escape") {setMention(null);setEmojiOpen(false);return;}
    if(mention && !e.shiftKey && ["ArrowDown","ArrowUp","Enter","Tab"].includes(e.key)) {
      if(e.key==="Tab" && !matches.length) {setMention(null);return;}
      e.preventDefault();
      if(e.key==="ArrowDown") setActive((selected+1)%Math.max(1,matches.length));
      else if(e.key==="ArrowUp") setActive((selected-1+matches.length)%Math.max(1,matches.length));
      else if(matches[selected]) chooseMention(matches[selected]);
      return;
    }
    if(e.key==="Enter" && !e.shiftKey) {e.preventDefault();send();}
  };
  const sendFiles = useSendFiles(conv, block);
  // The same file input can pick the same file again; the pick is handed over and forgotten.
  const picked = e => { const list = [...e.target.files]; e.target.value = ""; sendFiles(list); };
  const paste = e => {
    const images = [...(e.clipboardData?.files ?? [])].filter(f => f.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    sendFiles(images);
  };
  const limitNote = tooLong ? `消息最多 ${TEXT_LIMIT} 字，当前 ${length} 字，请删减后再发送` : null;
  return <footer className="composer" ref={rootRef} onKeyDown={e=>{if(e.key==="Escape"){setEmojiOpen(false);setMention(null);}}}>
    {replyTo && <div className="reply-chip"><span>回复 {senderName(state,replyTo.from)}：{replyTo.kind==="image"?"[图片]":replyTo.text}</span><IconBtn label="取消回复" onClick={()=>setReplyTo(null)}><X size={14}/></IconBtn></div>}
    <div className="composer-tools">
      <div className="menu-anchor">
        <IconBtn label="表情" disabled={disabled} aria-expanded={emojiOpen} aria-controls="emoji-picker" onClick={()=>{setEmojiOpen(!emojiOpen);setMention(null);}}><Smile size={22}/></IconBtn>
        {emojiOpen && <div className="emoji-picker" id="emoji-picker" role="dialog" aria-label="选择表情">
          <div className="emoji-heading"><strong>表情</strong><IconBtn label="关闭表情" onClick={()=>setEmojiOpen(false)}><X size={16}/></IconBtn></div>
          <div className="emoji-tabs" role="tablist" aria-label="表情分类">{Object.keys(EMOJI).map(c=><button key={c} type="button" role="tab" aria-selected={category===c} onClick={()=>setCategory(c)}>{c}</button>)}</div>
          <div className="emoji-grid">{EMOJI[category].map(emoji=><button key={emoji} type="button" aria-label={`插入表情 ${emoji}`} onClick={()=>replace(emoji)}>{emoji}</button>)}</div>
        </div>}
      </div>
      <IconBtn label="发送图片" disabled={disabled} onClick={()=>imagePicker.current?.click()}><Image size={22}/></IconBtn>
      <IconBtn label="发送文件" disabled={disabled} onClick={()=>filePicker.current?.click()}><Paperclip size={22}/></IconBtn>
      <input ref={imagePicker} type="file" accept="image/*" multiple hidden tabIndex={-1} aria-label="选择图片" onChange={picked}/>
      <input ref={filePicker} type="file" multiple hidden tabIndex={-1} aria-label="选择文件" onChange={picked}/>
      {people.length>0 && <IconBtn label="@ 会话成员" disabled={disabled} aria-expanded={Boolean(mention)} onClick={openMentions}><AtSign size={22}/></IconBtn>}
    </div>
    <div className="composer-row">
      <div className="composer-input">
        <div className="composer-resize" role="separator" aria-label="拖拽输入框上边框调整高度" aria-orientation="horizontal" aria-valuemin={56} aria-valuemax={maxHeight()} aria-valuenow={height} tabIndex={0} title="拖拽输入框上边框调整高度；双击恢复"
          onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();setMention(null);setEmojiOpen(false);e.currentTarget.setPointerCapture(e.pointerId);drag.current={y:e.clientY,height:inputRef.current?.getBoundingClientRect().height || height};}}
          onPointerMove={e=>{if(drag.current)setHeight(clampHeight(drag.current.height+drag.current.y-e.clientY));}}
          onPointerUp={e=>{drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
          onPointerCancel={()=>{drag.current=null;}}
          onDoubleClick={()=>setHeight(64)}
          onKeyDown={e=>{if(["ArrowUp","ArrowDown","Home","End"].includes(e.key)){e.preventDefault();setHeight(e.key==="Home"?56:e.key==="End"?maxHeight():clampHeight(height+(e.key==="ArrowUp"?20:-20)));}}} />
        {mention && !disabled && <div className="mention-picker" id="mention-picker" role="listbox" aria-label="选择要提及的成员">
          <div className="mention-heading">提及会话中的成员 <small>↑↓ 选择 · Enter 确认</small></div>
          {!matches.length && <p className="mention-empty">没有匹配的成员</p>}
          {matches.map((id,i)=><button key={id} id={`mention-${id}`} role="option" aria-selected={i===selected} type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>chooseMention(id)}>
            <Avatar id={id} size={28}/><span><strong>{nameOf(state,id)}</strong><small>真人 · 会话成员</small></span>
          </button>)}
        </div>}
        <textarea ref={inputRef} rows={1} value={text} style={{height}} disabled={disabled} placeholder={disabled?"当前无法发送新消息":"发送消息，或 @ 会话成员"} aria-label="消息内容" aria-autocomplete="list" aria-controls={mention?"mention-picker":undefined} aria-expanded={Boolean(mention)} aria-activedescendant={mention&&matches[selected]?`mention-${matches[selected]}`:undefined}
          onChange={e=>{edit(e.target.value);detect(e.target.value,e.target.selectionStart,e.target.selectionEnd);}}
          onSelect={e=>{selection.current={start:e.target.selectionStart,end:e.target.selectionEnd};}}
          onClick={e=>detect(e.target.value,e.target.selectionStart,e.target.selectionEnd)} onKeyDown={keyDown} onPaste={paste}
          onKeyUp={e=>{if(!e.nativeEvent.isComposing && ["ArrowLeft","ArrowRight","Home","End"].includes(e.key))detect(e.target.value,e.target.selectionStart,e.target.selectionEnd);}}/>
      </div>
      <Btn variant="primary" className="send" disabled={disabled||!text.trim()||tooLong} reason={block?.text ?? limitNote} onClick={()=>send()}>发送</Btn>
    </div>
    <p className="composer-hint">{disabled?block.text:limitNote?<span className="failed">{limitNote}</span>:"Enter 发送 · Shift+Enter 换行"}</p>
  </footer>;
}
