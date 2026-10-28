import { useMemo, useRef, useState } from 'react';
import {
  formatRecipientToken,
  parseRecipientList,
  parseRecipientToken,
  suggestRecipients,
} from '../mail/people.js';
import { Icon } from './Icon.jsx';

function sameRecipient(left, right) {
  return String(left?.email || '').trim().toLowerCase() === String(right?.email || '').trim().toLowerCase();
}

export function RecipientField({
  label,
  values = [],
  onChange,
  contacts = [],
  placeholder = '',
  autoFocus = false,
  extra,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const suggestions = useMemo(
    () => suggestRecipients(contacts, query, values),
    [contacts, query, values],
  );
  const showSuggestions = open && suggestions.length > 0;
  const listId = `${String(label || 'recipients').toLowerCase().replace(/\s+/g, '-')}-suggestions`;

  const addRecipients = (next) => {
    const incoming = (Array.isArray(next) ? next : [next]).filter(Boolean);
    if (!incoming.length) return;
    const merged = [...values];
    incoming.forEach((person) => {
      if (!merged.some((item) => sameRecipient(item, person))) merged.push(person);
    });
    onChange(merged);
    setQuery('');
    setActiveIndex(0);
  };

  const commitQuery = ({ requireValid = false } = {}) => {
    const tokens = parseRecipientList(query).filter((item) => !requireValid || item.valid);
    if (!tokens.length) return false;
    addRecipients(tokens);
    return true;
  };

  const removeAt = (index) => {
    onChange(values.filter((_, itemIndex) => itemIndex !== index));
    inputRef.current?.focus();
  };

  const chooseSuggestion = (person) => {
    addRecipients({
      name: person.name && person.name !== person.email ? person.name : '',
      email: person.email,
      valid: true,
    });
    setOpen(false);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape' && showSuggestions) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (showSuggestions && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + delta + suggestions.length) % suggestions.length);
      return;
    }
    if (event.key === 'Enter' && showSuggestions && suggestions[activeIndex]) {
      event.preventDefault();
      chooseSuggestion(suggestions[activeIndex]);
      return;
    }
    if (['Enter', 'Tab', ',', ';'].includes(event.key) && query.trim()) {
      if (event.key !== 'Tab') event.preventDefault();
      if (showSuggestions && suggestions[activeIndex] && (event.key === 'Enter' || event.key === 'Tab')) {
        chooseSuggestion(suggestions[activeIndex]);
        return;
      }
      commitQuery();
      return;
    }
    if (event.key === 'Backspace' && !query && values.length) {
      event.preventDefault();
      removeAt(values.length - 1);
    }
  };

  const handlePaste = (event) => {
    const text = event.clipboardData?.getData('text') || '';
    if (!/[;,]\s*|\s+/.test(text)) return;
    const tokens = parseRecipientList(text.replace(/\s+/g, ' '));
    if (!tokens.length) return;
    event.preventDefault();
    addRecipients(tokens);
  };

  return (
    <div className="recipient-field">
      <div
        className="recipient-chip-row"
        onClick={() => inputRef.current?.focus()}
      >
        {values.map((person, index) => (
          <span
            key={`${person.email}-${index}`}
            className={`recipient-chip ${person.valid === false ? 'is-invalid' : ''}`}
            title={person.email}
          >
            <span>{person.name && person.valid !== false ? person.name : formatRecipientToken(person)}</span>
            <button
              type="button"
              className="recipient-chip-remove"
              aria-label={`Remove ${formatRecipientToken(person)}`}
              onClick={(event) => { event.stopPropagation(); removeAt(index); }}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={query}
          autoFocus={autoFocus}
          placeholder={values.length ? '' : placeholder}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={showSuggestions ? `${listId}-${activeIndex}` : undefined}
          onChange={(event) => {
            const next = event.target.value;
            if (/[,;]/.test(next)) {
              const parts = next.split(/[,;]+/);
              const complete = parts.slice(0, -1).map((part) => parseRecipientToken(part)).filter(Boolean);
              if (complete.length) addRecipients(complete);
              setQuery(parts.at(-1) || '');
              setOpen(true);
              setActiveIndex(0);
              return;
            }
            setQuery(next);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            commitQuery({ requireValid: true });
            setOpen(false);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
      </div>
      {extra}
      {showSuggestions && (
        <ul className="recipient-suggestions" id={listId} role="listbox" aria-label={`${label} suggestions`}>
          {suggestions.map((person, index) => (
            <li key={person.email} role="presentation">
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? 'is-active' : ''}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(person)}
              >
                <strong>{person.name || person.email}</strong>
                {person.name ? <small>{person.email}</small> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
