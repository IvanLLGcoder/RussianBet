import { useEffect, useState } from 'react';
import { Check, ChevronLeft, Copy, Minus, Plus, Share2, Spade, UserRound, X } from 'lucide-react';
import { request } from '../api';
import type { Invite, InvitePreview, Market, MarketValues, NotificationPreferences, NotificationSettings } from '../api';
import { categories, categoryLabels, credits, dateTime, localDateTime } from '../format';
import brand from '../brand';
import { BASE } from '../router';
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

type PreviewState = { status: 'loading' } | { status: 'error' } | ({ status: 'done' } & InvitePreview);

export function AuthModal({
  mode,
  banque,
  connexionPoker,
  soldeDepart,
  initialInviteCode,
  onModeChange,
  onClose,
  onSubmit,
}: {
  mode: AuthMode;
  banque: boolean;
  connexionPoker: boolean;
  soldeDepart: number;
  initialInviteCode: string;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  onSubmit: (mode: AuthMode, values: Record<string, string>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
  // Lien d'invitation en mode banque : on demande d'abord « déjà au poker ? » pour ne pas créer de doublon.
  const [etape, setEtape] = useState<'choix' | 'liste' | 'nouveau'>('choix');
  const [noms, setNoms] = useState<string[] | null>(null);
  const [nomsErreur, setNomsErreur] = useState('');
  const [filtre, setFiltre] = useState('');
  const [choisi, setChoisi] = useState('');
  const [nomPris, setNomPris] = useState('');
  const register = mode === 'register';
  // Arrivée par un lien d'invitation : le code est caché et prérempli, seuls le nom et le mot de passe sont demandés.
  const fromLink = initialInviteCode.trim() !== '';
  const code = initialInviteCode.trim();

  useEffect(() => {
    if (!fromLink) return;
    let active = true;
    request<InvitePreview>(`/api/invites/${encodeURIComponent(code)}`)
      .then((result) => { if (active) setPreview({ status: 'done', ...result }); })
      .catch(() => { if (active) setPreview({ status: 'error' }); });
    return () => { active = false; };
  }, [fromLink, code]);

  useEffect(() => {
    if (etape !== 'liste' || noms !== null || !fromLink) return;
    request<{ noms: string[] }>(`/api/invites/${encodeURIComponent(code)}/joueurs`)
      .then((result) => setNoms(result.noms))
      .catch((problem) => setNomsErreur(errorText(problem, 'Liste des joueurs indisponible.')));
  }, [etape, noms, fromLink, code]);

  async function envoyer(next: AuthMode, values: Record<string, string>) {
    setBusy(true);
    setError('');
    setNomPris('');
    try {
      await onSubmit(next, values);
    } catch (problem) {
      const message = errorText(problem, 'Connexion impossible.');
      // Nom déjà pris au poker : c'est probablement la même personne, on propose de se connecter.
      if (banque && next === 'register' && /déjà pris/.test(message)) setNomPris(values.username ?? '');
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    void envoyer(mode, values);
  }

  const switchTo = (next: AuthMode) => { onModeChange(next); setError(''); };
  const allerA = (next: typeof etape, nom = '') => { setEtape(next); setChoisi(nom); setError(''); setNomPris(''); };
  const invalidLink = register && fromLink && preview.status === 'done' && !preview.valid;
  const inviter = preview.status === 'done' ? preview.inviter : null;
  const parcoursPoker = register && fromLink && banque && !invalidLink;
  const lienPoker = `${BASE}/api/auth/poker?suite=${encodeURIComponent('/')}`;
  const boutonPoker = connexionPoker && (
    <a className="btn btn-primary btn-block btn-poker" href={lienPoker}><Spade size={17} fill="currentColor" />Continuer avec mon compte poker</a>
  );

  let head: React.ReactNode;
  if (!register) {
    head = (
      <div className="auth-head">
        <Logo size={44} />
        <h2>Content de vous revoir</h2>
        <p>Connectez-vous pour retrouver vos positions.{banque && ' Même compte que le poker.'}</p>
      </div>
    );
  } else if (invalidLink) {
    head = (
      <div className="auth-head">
        <Logo size={44} />
        <h2>Invitation invalide</h2>
        <p>Ce lien d’invitation est invalide ou a expiré. Demandez-en un nouveau à la personne qui vous l’a envoyé.</p>
      </div>
    );
  } else if (fromLink) {
    head = (
      <div className="auth-head">
        <Logo size={44} />
        <h2>{inviter ? <><strong className="auth-inviter">{inviter}</strong> t’invite sur <Wordmark /></> : <>Rejoindre <Wordmark /></>}</h2>
        <p>
          {parcoursPoker && etape !== 'nouveau'
            ? 'Mêmes jetons et même compte que le poker. Tu y joues déjà ?'
            : <>Choisissez un nom et un mot de passe. {credits(soldeDepart)} offerts à l’arrivée.</>}
        </p>
      </div>
    );
  } else {
    head = (
      <div className="auth-head">
        <Logo size={44} />
        <h2>Rejoindre <Wordmark /></h2>
        <p>Inscription sur invitation. {credits(soldeDepart)} offerts à l’arrivée.</p>
      </div>
    );
  }

  const erreurNomPris = error && (
    <div className="form-error" role="alert">
      {error}
      {nomPris && <button type="button" className="btn-text auth-inline" onClick={() => allerA('liste', nomPris)}>C’est moi : me connecter</button>}
    </div>
  );

  const filtreNorm = filtre.trim().toLocaleLowerCase('fr');
  const nomsVisibles = (noms ?? []).filter((nom) => !filtreNorm || nom.toLocaleLowerCase('fr').includes(filtreNorm));

  let corps: React.ReactNode;
  if (invalidLink) {
    corps = <button className="btn btn-primary btn-block" type="button" onClick={() => switchTo('login')}>Se connecter</button>;
  } else if (parcoursPoker && etape === 'choix') {
    corps = (
      <div className="auth-choices">
        {boutonPoker}
        {boutonPoker && <p className="auth-choice-hint">Déjà connecté au poker sur cet appareil ? Un seul toucher.</p>}
        <button className={`btn btn-block ${boutonPoker ? 'btn-ghost' : 'btn-primary'}`} type="button" onClick={() => allerA('liste')}>
          <UserRound size={17} />Je suis au poker : choisir mon nom
        </button>
        <div className="auth-divider"><span>Nouveau ici ?</span></div>
        <button className="btn btn-ghost btn-block" type="button" onClick={() => allerA('nouveau')}><Plus size={17} />Créer un compte</button>
      </div>
    );
  } else if (parcoursPoker && etape === 'liste') {
    corps = (
      <div className="auth-names-step">
        <button type="button" className="auth-back" onClick={() => (choisi ? setChoisi('') : allerA('choix'))}><ChevronLeft size={16} />Retour</button>
        {choisi ? (
          <form className="form" onSubmit={(event) => {
            event.preventDefault();
            const password = String(new FormData(event.currentTarget).get('password') ?? '');
            void envoyer('login', { identity: choisi, password });
          }}>
            <div className="auth-me"><span className="auth-me-avatar">{choisi.slice(0, 1).toUpperCase()}</span><div><small>Connexion en tant que</small><strong>{choisi}</strong></div></div>
            <input type="hidden" name="identity" value={choisi} autoComplete="username" />
            <label>Mot de passe du poker<input autoFocus autoComplete="current-password" name="password" type="password" maxLength={128} required /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-block" type="submit" disabled={busy}>{busy ? 'Un instant…' : 'Se connecter'}</button>
            {boutonPoker && <p className="auth-choice-hint">Mot de passe oublié ? Connecte-toi plutôt avec <a href={lienPoker}>ton compte poker</a>.</p>}
          </form>
        ) : (
          <>
            <p className="auth-step-title">Qui es-tu ?</p>
            {(noms?.length ?? 0) > 8 && (
              <input className="auth-filter" type="search" placeholder="Chercher mon nom" value={filtre} onChange={(event) => setFiltre(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            )}
            {nomsErreur && <p className="form-error" role="alert">{nomsErreur}</p>}
            {!noms && !nomsErreur && <p className="auth-choice-hint">Chargement des joueurs…</p>}
            {noms && (
              <div className="auth-names">
                {nomsVisibles.map((nom) => (
                  <button key={nom} type="button" onClick={() => allerA('liste', nom)}>
                    <span className="auth-me-avatar">{nom.slice(0, 1).toUpperCase()}</span>{nom}
                  </button>
                ))}
                {nomsVisibles.length === 0 && <p className="auth-choice-hint">Aucun joueur à ce nom.</p>}
              </div>
            )}
          </>
        )}
      </div>
    );
  } else {
    corps = (
      <form className="form" onSubmit={handleSubmit}>
        {parcoursPoker && <button type="button" className="auth-back" onClick={() => allerA('choix')}><ChevronLeft size={16} />Retour</button>}
        {!register && boutonPoker && <>{boutonPoker}<div className="auth-divider"><span>ou</span></div></>}
        {register ? (
          <>
            {fromLink
              ? <input type="hidden" name="inviteCode" value={initialInviteCode} />
              : <label>Code d’invitation<input autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} name="inviteCode" placeholder="ABC123DEF456" required /></label>}
            <label>Nom
              <input
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                name="username"
                minLength={banque ? 2 : 3}
                maxLength={20}
                pattern={banque ? undefined : '[A-Za-z0-9_]{3,20}'}
                title={banque ? '2 à 20 caractères' : '3 à 20 lettres, chiffres ou _'}
                required
              />
              <span className="field-hint">{banque ? '2 à 20 caractères (lettres, accents, espaces et points acceptés) · servira aussi au poker' : '3 à 20 lettres, chiffres ou _'}</span>
            </label>
          </>
        ) : (
          <label>{banque ? 'Nom' : 'Nom ou e-mail'}<input autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} name="identity" required /></label>
        )}
        <label>Mot de passe<input autoComplete={register ? 'new-password' : 'current-password'} name="password" type="password" minLength={register ? (banque ? 8 : 6) : undefined} maxLength={128} placeholder={register ? `${banque ? 8 : 6} caractères minimum` : ''} required /></label>
        {erreurNomPris}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Un instant…' : register ? 'Créer mon compte' : 'Se connecter'}
        </button>
      </form>
    );
  }

  return (
    <Modal title={register ? 'Inscription' : 'Connexion'} onClose={onClose}>
      {head}
      {!(register && fromLink) && (
        <div className="segmented auth-tabs" role="tablist">
          <button role="tab" aria-selected={!register} className={!register ? 'active' : ''} onClick={() => switchTo('login')}>Connexion</button>
          <button role="tab" aria-selected={register} className={register ? 'active' : ''} onClick={() => switchTo('register')}>Inscription</button>
        </div>
      )}
      {corps}
      {register && fromLink && !parcoursPoker && (
        <button className="auth-switch" type="button" onClick={() => switchTo('login')}>J’ai déjà un compte</button>
      )}
      <p className="modal-fineprint">Jetons virtuels uniquement : aucun dépôt, aucun retrait.</p>
    </Modal>
  );
}

function inviteUrl(code: string) {
  return `${window.location.origin}${BASE}/?invite=${encodeURIComponent(code)}`;
}

export function InviteModal({ onClose }: { onClose: () => void }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    request<{ invite: Invite }>('/api/invites/link', { method: 'POST' })
      .then((result) => setInvite(result.invite))
      .catch((problem) => setError(errorText(problem, 'Impossible de créer le lien d’invitation.')));
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const link = invite ? inviteUrl(invite.code) : '';

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setError('');
    } catch {
      setError('Presse-papiers indisponible : sélectionnez le lien pour le copier.');
    }
  }

  async function shareLink() {
    try {
      await navigator.share({ title: brand.name, text: `Rejoins-moi sur ${brand.name}`, url: link });
    } catch (problem) {
      // Fermer la feuille de partage n'est pas une erreur.
      if (!(problem instanceof DOMException && problem.name === 'AbortError')) setError('Partage impossible : copiez le lien à la place.');
    }
  }

  return (
    <Modal title="Inviter" onClose={onClose}>
      <h2 className="modal-title">Inviter des amis</h2>
      <p className="modal-intro">Envoyez ce lien : il suffit d’un nom et d’un mot de passe pour s’inscrire. Il peut servir à autant de personnes que vous voulez.</p>
      {invite ? (
        <>
          <input
            className="invite-link"
            readOnly
            value={link}
            aria-label="Lien d’invitation"
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="invite-actions">
            {canShare && <button className="btn btn-primary btn-large" onClick={() => void shareLink()}><Share2 size={18} />Partager</button>}
            <button className={`btn btn-large ${canShare ? 'btn-ghost' : 'btn-primary'}`} onClick={() => void copyLink()}>
              {copied ? <><Check size={18} />Lien copié</> : <><Copy size={18} />Copier le lien</>}
            </button>
          </div>
          <p className="invite-stats">
            <strong>{invite.redeemedCount}</strong> {invite.redeemedCount > 1 ? 'personnes inscrites' : 'personne inscrite'} avec ce lien
            {' · '}expire le {dateTime(invite.expiresAt)}
          </p>
        </>
      ) : !error && <p className="muted">Préparation du lien…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
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
      const registration = await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
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

export function HowItWorksModal({ banque, soldeDepart, onClose }: { banque: boolean; soldeDepart: number; onClose: () => void }) {
  const steps = [
    {
      title: 'Choisissez un marché',
      body: 'Chaque marché est une question sur un événement futur. Le pourcentage affiché est la probabilité estimée par la bande, calculée à partir du nombre de prises sur chaque issue.',
    },
    {
      title: 'Achetez une issue',
      body: 'Le prix (par exemple 62¢) est le coût d’une part qui rapporte 1 jeton si l’issue gagne. Votre cote est verrouillée au moment de l’ordre ; les prises suivantes ne la changent pas.',
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
      <p className="modal-fineprint">Chaque compte démarre avec {credits(soldeDepart)}, sans valeur monétaire. {banque && 'Le solde est commun avec le poker, avec une allocation de 250 jetons par jour. '}Le créateur d’un marché le résout (et ne peut pas y miser) ; la résolution est définitive.</p>
      <button className="btn btn-primary btn-block" onClick={onClose}>Compris</button>
    </Modal>
  );
}
