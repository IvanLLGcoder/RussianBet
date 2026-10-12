import { useEffect, useState } from 'react';
import { Check, Copy, Link2, Minus, Plus, X } from 'lucide-react';
import { request } from '../api';
import type { Invite, Market, MarketValues, NotificationPreferences, NotificationSettings } from '../api';
import { categories, categoryLabels, dateTime, localDateTime } from '../format';
import { Logo, Wordmark } from './Logo';

export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <button className="modal-close" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        {children}
      </section>
    </div>
  );
}

function errorText(problem: unknown, fallback: string) {
  return problem instanceof Error ? problem.message : fallback;
}

export type AuthMode = 'register' | 'login';

export function AuthModal({
  mode,
  initialInviteCode,
  onModeChange,
  onClose,
  onSubmit,
}: {
  mode: AuthMode;
  initialInviteCode: string;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  onSubmit: (mode: AuthMode, values: Record<string, string>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const register = mode === 'register';

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    setBusy(true);
    setError('');
    try {
      await onSubmit(mode, values);
    } catch (problem) {
      setError(errorText(problem, 'Connexion impossible.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={register ? 'Inscription' : 'Connexion'} onClose={onClose}>
      <div className="auth-head">
        <Logo size={44} />
        <h2>{register ? <>Rejoindre <Wordmark /></> : 'Content de vous revoir'}</h2>
        <p>{register ? 'Inscription sur invitation. 1 000 crédits offerts à l’arrivée.' : 'Connectez-vous pour retrouver vos positions.'}</p>
      </div>
      <div className="segmented auth-tabs" role="tablist">
        <button role="tab" aria-selected={!register} className={!register ? 'active' : ''} onClick={() => { onModeChange('login'); setError(''); }}>Connexion</button>
        <button role="tab" aria-selected={register} className={register ? 'active' : ''} onClick={() => { onModeChange('register'); setError(''); }}>Inscription</button>
      </div>
      <form className="form" onSubmit={(event) => void handleSubmit(event)}>
        {register ? (
          <>
            <label>Pseudo<input autoComplete="username" name="username" placeholder="3 à 20 caractères" minLength={3} maxLength={20} required /></label>
            <label>E-mail<input autoComplete="email" name="email" type="email" placeholder="vous@exemple.fr" required /></label>
            <label>Code d’invitation<input autoComplete="off" name="inviteCode" placeholder="ABC123DEF456" defaultValue={initialInviteCode} required /></label>
          </>
        ) : (
          <label>Pseudo ou e-mail<input autoComplete="username" name="identity" required /></label>
        )}
        <label>Mot de passe<input autoComplete={register ? 'new-password' : 'current-password'} name="password" type="password" minLength={register ? 8 : undefined} placeholder={register ? '8 caractères minimum' : ''} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Un instant…' : register ? 'Créer mon compte' : 'Se connecter'}
        </button>
      </form>
      <p className="modal-fineprint">Crédits virtuels uniquement : aucun dépôt, aucun retrait.</p>
    </Modal>
  );
}

function inviteUrl(code: string) {
  return `${window.location.origin}/?invite=${encodeURIComponent(code)}`;
}

export function InviteModal({ onClose }: { onClose: () => void }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copiedCode, setCopiedCode] = useState('');
  const [validForDays, setValidForDays] = useState(7);

  useEffect(() => {
    request<{ invites: Invite[] }>('/api/invites')
      .then((result) => setInvites(result.invites))
      .catch((problem) => setError(errorText(problem, 'Impossible de charger vos invitations.')));
  }, []);

  async function copyLink(code: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(code));
      setCopiedCode(code);
      setError('');
    } catch {
      setError('Presse-papiers indisponible : sélectionnez le lien pour le copier.');
    }
  }

  async function generateInvite() {
    setBusy(true);
    setError('');
    try {
      const result = await request<{ invite: Invite }>('/api/invites', {
        method: 'POST',
        body: JSON.stringify({ validForDays }),
      });
      setInvites((current) => [result.invite, ...(current ?? [])]);
      await copyLink(result.invite.code);
    } catch (problem) {
      setError(errorText(problem, 'Impossible de créer l’invitation.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Inviter" onClose={onClose}>
      <h2 className="modal-title">Inviter quelqu’un</h2>
      <p className="modal-intro">Un lien d’invitation peut servir plusieurs fois jusqu’à son expiration.</p>
      <div className="invite-create">
        <div className="segmented" role="radiogroup" aria-label="Durée de validité">
          {[1, 7, 30].map((days) => (
            <button key={days} role="radio" aria-checked={validForDays === days} className={validForDays === days ? 'active' : ''} onClick={() => setValidForDays(days)}>
              {days} {days === 1 ? 'jour' : 'jours'}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => void generateInvite()} disabled={busy}>
          <Plus size={16} />{busy ? 'Création…' : 'Créer un lien'}
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="list-heading">Vos invitations <span>{invites?.length ?? 0}</span></div>
      {invites === null ? <p className="muted">Chargement…</p> : invites.length === 0 ? (
        <p className="muted">Aucune invitation pour l’instant.</p>
      ) : (
        <div className="invite-list">
          {invites.map((invite) => {
            const expired = new Date(invite.expiresAt).getTime() <= Date.now();
            return (
              <div className={`invite-row${expired ? ' invite-expired' : ''}`} key={invite.code}>
                <div className="invite-row-main">
                  <span className="invite-code"><Link2 size={13} />{invite.code}</span>
                  <small>{expired ? 'Expirée' : `Expire le ${dateTime(invite.expiresAt)}`} · {invite.redeemedCount} inscription{invite.redeemedCount > 1 ? 's' : ''}</small>
                </div>
                <button className="icon-btn" title="Copier le lien" aria-label={`Copier l’invitation ${invite.code}`} disabled={expired} onClick={() => void copyLink(invite.code)}>
                  {copiedCode === invite.code ? <Check size={16} /> : <Copy size={15} />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(window.atob(base64), (character) => character.charCodeAt(0));
}

export function NotificationsModal({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await request<NotificationSettings>('/api/notifications/settings');
        const registration = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
        const existing = registration ? await registration.pushManager.getSubscription() : null;
        if (active) {
          setSettings(result);
          setSubscription(existing);
        }
      } catch (problem) {
        if (active) setError(errorText(problem, 'Impossible de charger les réglages.'));
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, []);

  async function enablePush() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (!settings?.pushEnabled || !settings.publicKey) throw new Error('Le push n’est pas encore configuré sur ce serveur.');
      if (!window.isSecureContext) throw new Error('Le push nécessite HTTPS (sauf en localhost).');
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        throw new Error('Ce navigateur ne gère pas les notifications push.');
      }
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') throw new Error('Autorisez les notifications dans les réglages du navigateur.');
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const next = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(settings.publicKey),
        });
      await request('/api/notifications/subscriptions', { method: 'POST', body: JSON.stringify(next.toJSON()) });
      setSubscription(next);
      setSettings((current) => current ? { ...current, hasSubscription: true } : current);
      setMessage('Notifications activées sur ce navigateur.');
    } catch (problem) {
      setError(errorText(problem, 'Impossible d’activer le push.'));
    } finally {
      setBusy(false);
    }
  }

  async function updatePreferences(key: keyof NotificationPreferences, value: boolean) {
    if (!settings) return;
    setBusy(true);
    setError('');
    setMessage('');
    const preferences = { ...settings.preferences, [key]: value };
    try {
      await request('/api/notifications/preferences', { method: 'PUT', body: JSON.stringify(preferences) });
      setSettings({ ...settings, preferences });
    } catch (problem) {
      setError(errorText(problem, 'Impossible d’enregistrer les préférences.'));
    } finally {
      setBusy(false);
    }
  }

  async function disableThisBrowser() {
    if (!subscription || !settings) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await request<{ hasSubscription: boolean }>('/api/notifications/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      await subscription.unsubscribe();
      setSubscription(null);
      setSettings({ ...settings, hasSubscription: result.hasSubscription });
      setMessage('Notifications désactivées sur ce navigateur.');
    } catch (problem) {
      setError(errorText(problem, 'Impossible de désactiver le push.'));
    } finally {
      setBusy(false);
    }
  }

  const unsupported = !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window);
  const denied = 'Notification' in window && Notification.permission === 'denied';
  const toggles: { key: keyof NotificationPreferences; title: string; detail: string }[] = [
    { key: 'newPolls', title: 'Nouveaux marchés', detail: 'Quand quelqu’un crée un marché.' },
    { key: 'participatedResolutions', title: 'Résolutions', detail: 'Quand un marché où vous avez une position est résolu.' },
  ];

  return (
    <Modal title="Notifications" onClose={onClose}>
      <h2 className="modal-title">Notifications</h2>
      <p className="modal-intro">Choisissez ce qui déclenche une notification sur ce navigateur.</p>
      {loading ? <p className="muted">Chargement…</p> : (
        <>
          {!settings?.pushEnabled && <p className="note">Le push n’est pas configuré sur ce serveur (clés VAPID manquantes).</p>}
          {settings?.pushEnabled && (!window.isSecureContext || unsupported) && <p className="note">Le push nécessite un navigateur compatible et HTTPS.</p>}
          {denied && <p className="note">Les notifications sont bloquées par ce navigateur. Autorisez-les dans les réglages du site.</p>}
          {settings?.pushEnabled && window.isSecureContext && !unsupported && (
            <div className="device-row">
              <span>{subscription ? 'Ce navigateur est connecté' : settings.hasSubscription ? 'Un autre navigateur est connecté' : 'Aucun navigateur connecté'}</span>
              {subscription
                ? <button className="btn btn-ghost" onClick={() => void disableThisBrowser()} disabled={busy}>Désactiver ici</button>
                : <button className="btn btn-primary" onClick={() => void enablePush()} disabled={busy}>{busy ? 'Connexion…' : 'Activer le push'}</button>}
            </div>
          )}
          {toggles.map((toggle) => (
            <label className="switch-row" key={toggle.key}>
              <span><strong>{toggle.title}</strong><small>{toggle.detail}</small></span>
              <input
                type="checkbox"
                className="switch"
                checked={settings?.preferences[toggle.key] ?? false}
                disabled={busy || !subscription || !settings?.pushEnabled}
                onChange={(event) => void updatePreferences(toggle.key, event.target.checked)}
              />
            </label>
          ))}
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
    </Modal>
  );
}

const durationPresets = [
  { label: '1 h', ms: 3_600_000 },
  { label: '1 jour', ms: 86_400_000 },
  { label: '1 semaine', ms: 7 * 86_400_000 },
  { label: '1 mois', ms: 30 * 86_400_000 },
];

// Création et modification partagent le même formulaire ; les issues ne sont modifiables qu'à la création.
export function MarketFormModal({
  market,
  onClose,
  onCreate,
  onEdit,
}: {
  market?: Market;
  onClose: () => void;
  onCreate?: (values: MarketValues & { options: string[] }) => Promise<void>;
  onEdit?: (values: MarketValues) => Promise<void>;
}) {
  const editing = Boolean(market);
  const [title, setTitle] = useState(market?.title ?? '');
  const [description, setDescription] = useState(market?.description ?? '');
  const [category, setCategory] = useState(market?.category ?? 'Community');
  const [kind, setKind] = useState<'binary' | 'multiple'>('binary');
  const [options, setOptions] = useState(['', '', '']);
  const [endsAt, setEndsAt] = useState(localDateTime(market ? new Date(market.endsAt) : new Date(Date.now() + 7 * 86_400_000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const values = { title, description, category, endsAt: new Date(endsAt).toISOString() };
    try {
      if (editing) await onEdit?.(values);
      else await onCreate?.({ ...values, options: kind === 'binary' ? ['Oui', 'Non'] : options.map((option) => option.trim()).filter(Boolean) });
    } catch (problem) {
      setError(errorText(problem, 'Enregistrement impossible.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? 'Modifier le marché' : 'Créer un marché'} onClose={onClose} wide>
      <h2 className="modal-title">{editing ? 'Modifier le marché' : 'Créer un marché'}</h2>
      <form className="form" onSubmit={(event) => void handleSubmit(event)}>
        <label>Question
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Est-ce que … avant le 31 décembre ?" minLength={8} maxLength={100} required />
          <small className="counter">{title.length}/100</small>
        </label>
        <label>Règles de résolution
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={280} placeholder="Ce marché se résout par « Oui » si …" />
          <small className="counter">{description.length}/280</small>
        </label>
        <fieldset>
          <legend>Catégorie</legend>
          <div className="chip-row">
            {categories.map((entry) => (
              <button type="button" key={entry} className={`chip${category === entry ? ' active' : ''}`} onClick={() => setCategory(entry)}>
                {categoryLabels[entry]}
              </button>
            ))}
          </div>
        </fieldset>
        {editing ? (
          <p className="note">Les issues ({market!.options.join(' · ')}) ne peuvent plus être modifiées.</p>
        ) : (
          <fieldset>
            <legend>Issues</legend>
            <div className="segmented">
              <button type="button" className={kind === 'binary' ? 'active' : ''} onClick={() => setKind('binary')}>Oui / Non</button>
              <button type="button" className={kind === 'multiple' ? 'active' : ''} onClick={() => setKind('multiple')}>Choix multiples</button>
            </div>
            {kind === 'multiple' && (
              <div className="option-editor">
                {options.map((option, index) => (
                  <div className="option-input" key={index}>
                    <span className="option-index">{index + 1}</span>
                    <input
                      value={option}
                      onChange={(event) => setOptions(options.map((entry, position) => position === index ? event.target.value : entry))}
                      placeholder={`Issue ${index + 1}`}
                      maxLength={40}
                      required={index < 2}
                    />
                    {options.length > 2 && (
                      <button type="button" className="icon-btn" aria-label="Retirer l’issue" onClick={() => setOptions(options.filter((_, position) => position !== index))}>
                        <Minus size={15} />
                      </button>
                    )}
                  </div>
                ))}
                {options.length < 6 && (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => setOptions([...options, ''])}><Plus size={14} /> Ajouter une issue</button>
                )}
              </div>
            )}
          </fieldset>
        )}
        <fieldset>
          <legend>Clôture des prises</legend>
          <div className="chip-row">
            {durationPresets.map((preset) => (
              <button type="button" key={preset.label} className="chip" onClick={() => setEndsAt(localDateTime(new Date(Date.now() + preset.ms)))}>
                {preset.label}
              </button>
            ))}
          </div>
          <input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} required aria-label="Date de clôture" />
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Enregistrement…' : editing ? 'Enregistrer' : 'Publier le marché'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function HowItWorksModal({ onClose }: { onClose: () => void }) {
  const steps = [
    {
      title: 'Choisissez un marché',
      body: 'Chaque marché est une question sur un événement futur. Le pourcentage affiché est la probabilité estimée par la bande, calculée à partir du nombre de prises sur chaque issue.',
    },
    {
      title: 'Achetez une issue',
      body: 'Le prix (par exemple 62¢) est le coût d’une part qui rapporte 1 crédit si l’issue gagne. Votre cote est verrouillée au moment de l’ordre ; les prises suivantes ne la changent pas.',
    },
    {
      title: 'Encaissez si vous avez raison',
      body: 'Une seule prise par marché. À la résolution, une position gagnante rapporte mise × cote (arrondi à l’inférieur). Une position perdante ne rapporte rien. Un marché annulé rembourse tout le monde.',
    },
  ];
  return (
    <Modal title="Comment ça marche" onClose={onClose}>
      <h2 className="modal-title">Comment ça marche</h2>
      <ol className="how-steps">
        {steps.map((step, index) => (
          <li key={step.title}>
            <span className="how-index">{index + 1}</span>
            <div><strong>{step.title}</strong><p>{step.body}</p></div>
          </li>
        ))}
      </ol>
      <p className="modal-fineprint">Chaque compte démarre avec 1 000 crédits virtuels, sans valeur monétaire. Tout membre connecté peut résoudre un marché ; la première résolution est définitive.</p>
      <button className="btn btn-primary btn-block" onClick={onClose}>Compris</button>
    </Modal>
  );
}
