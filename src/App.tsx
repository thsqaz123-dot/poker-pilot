import { useEffect, useMemo, useState } from 'react'
import {
  applyAction, availableActions, buildSidePots, confirmBoardDealt, money, parseMoney, potTotal,
  settleShowdown, startHand, streetName, voidCurrentHand,
} from './engine'
import { loadState, saveState } from './storage'
import { playPokerSound } from './sounds'
import type { Game, PersistedState, PokerAction, Profile, Seat, Transaction } from './types'

const uid = () => globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
const now = () => new Date().toISOString()
const fmt = (cents: number) => `$${money(cents)}`
const signedFmt = (cents: number) => `${cents > 0 ? '+' : ''}${fmt(cents)}`
const SEAT_SLOTS: Record<number, number[]> = {
  2: [0, 3], 3: [0, 2, 4], 4: [0, 2, 3, 5], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5],
}

function chipColor(amount: number) {
  if (amount >= 50_000) return '#7b4bb7'
  if (amount >= 10_000) return '#242b2a'
  if (amount >= 2_500) return '#2b8b5c'
  if (amount >= 500) return '#c84d46'
  return '#e7dfc9'
}

function ChipVisual({ amount, small = false }: { amount: number; small?: boolean }) {
  return <span className={`chip-stack-icon ${small ? 'small' : ''}`} style={{ '--chip-color': chipColor(amount) } as React.CSSProperties} aria-hidden="true">
    <i /><i /><i />
  </span>
}

function PotPile({ amount, bigBlind, compact = false }: { amount: number; bigBlind: number; compact?: boolean }) {
  const count = amount <= 0 ? 0 : Math.min(compact ? 9 : 15, Math.max(1, Math.ceil(amount / Math.max(bigBlind, 1))))
  const colors = ['#e7dfc9', '#c84d46', '#2b8b5c', '#242b2a', '#7b4bb7', '#d5a72e']
  return <span className={`pot-pile ${compact ? 'compact' : ''}`} key={amount} aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <i key={index} style={{
      '--chip-color': colors[index % colors.length],
      left: `${(index % 5) * (compact ? 10 : 15) + (Math.floor(index / 5) % 2) * 4}px`,
      bottom: `${Math.floor(index / 5) * (compact ? 5 : 7)}px`,
      animationDelay: `${index * 18}ms`,
    } as React.CSSProperties} />)}
  </span>
}

const HELP = [
  { name: '로열 플러시', detail: 'A부터 10까지, 모두 같은 무늬', cards: ['A♠', 'K♠', 'Q♠', 'J♠', '10♠'] },
  { name: '스트레이트 플러시', detail: '연속된 숫자 5장, 모두 같은 무늬', cards: ['9♥', '8♥', '7♥', '6♥', '5♥'] },
  { name: '포카드', detail: '같은 숫자 4장', cards: ['Q♠', 'Q♥', 'Q♦', 'Q♣', '3♠'] },
  { name: '풀하우스', detail: '트리플 1개와 원페어 1개', cards: ['J♠', 'J♥', 'J♦', '7♣', '7♠'] },
  { name: '플러시', detail: '숫자는 달라도 같은 무늬 5장', cards: ['A♦', 'J♦', '8♦', '4♦', '2♦'] },
  { name: '스트레이트', detail: '무늬는 달라도 연속된 숫자 5장', cards: ['9♠', '8♥', '7♦', '6♣', '5♠'] },
  { name: '트리플', detail: '같은 숫자 3장', cards: ['8♠', '8♥', '8♦', 'K♣', '3♠'] },
  { name: '투페어', detail: '서로 다른 원페어 2개', cards: ['A♠', 'A♥', '5♦', '5♣', '9♠'] },
  { name: '원페어', detail: '같은 숫자 2장', cards: ['K♠', 'K♦', 'J♥', '7♣', '3♦'] },
  { name: '하이 카드', detail: '조합이 없을 때 가장 높은 카드', cards: ['A♠', 'J♦', '8♥', '5♣', '2♠'] },
]

type PlayerStats = {
  games: number
  gameWins: number
  gameLosses: number
  gameDraws: number
  net: number
  handsPlayed: number
  handsWon: number
}

function playerStats(profileId: string, archives: Game[], currentGame: Game | null): PlayerStats {
  const finishedSeats = archives.flatMap((game) => game.seats.filter((seat) => seat.profileId === profileId))
  const trackedGames = finishedSeats.filter((seat) => seat.buyInTotal !== undefined)
  const allCurrentSeats = currentGame ? [...(currentGame.departedSeats ?? []), ...currentGame.seats] : []
  const trackedSeats = [...finishedSeats, ...allCurrentSeats.filter((seat) => seat.profileId === profileId)]
  return {
    games: finishedSeats.length,
    gameWins: trackedGames.filter((seat) => seat.stack > (seat.buyInTotal ?? 0)).length,
    gameLosses: trackedGames.filter((seat) => seat.stack < (seat.buyInTotal ?? 0)).length,
    gameDraws: trackedGames.filter((seat) => seat.stack === (seat.buyInTotal ?? 0)).length,
    net: trackedGames.reduce((sum, seat) => sum + seat.stack - (seat.buyInTotal ?? seat.stack), 0),
    handsPlayed: trackedSeats.reduce((sum, seat) => sum + (seat.handsPlayed ?? 0), 0),
    handsWon: trackedSeats.reduce((sum, seat) => sum + (seat.handsWon ?? 0), 0),
  }
}

function tx(profileId: string, amount: number, type: Transaction['type'], note: string, profileName?: string): Transaction {
  return { id: uid(), profileId, profileName, amount, type, note, createdAt: now() }
}

export default function App() {
  const [data, setData] = useState<PersistedState>(() => loadState())
  const [screen, setScreen] = useState<'home' | 'setup' | 'table' | 'history'>(() => loadState().game ? 'table' : 'home')
  const [help, setHelp] = useState(false)
  const [undoGame, setUndoGame] = useState<Game | null>(null)
  const [toast, setToast] = useState('')

  useEffect(() => saveState(data), [data])
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(id)
  }, [toast])

  const update = (fn: (previous: PersistedState) => PersistedState) => setData(fn)

  const addProfile = (name: string, opening: number) => {
    const profile: Profile = { id: uid(), name, balance: opening, createdAt: now() }
    update((d) => ({ ...d, profiles: [...d.profiles, profile], transactions: [...d.transactions, tx(profile.id, opening, 'opening', '시작 잔액', profile.name)] }))
  }

  const updateProfile = (id: string, name: string, balance: number) => {
    update((d) => {
      const profile = d.profiles.find((p) => p.id === id)
      if (!profile) return d
      const nextBalance = Math.max(0, balance)
      const applied = nextBalance - profile.balance
      return {
        ...d,
        profiles: d.profiles.map((p) => p.id === id ? { ...p, name, balance: nextBalance } : p),
        game: d.game ? { ...d.game, seats: d.game.seats.map((s) => s.profileId === id ? { ...s, name } : s) } : null,
        transactions: applied === 0 ? d.transactions : [...d.transactions, tx(id, applied, 'adjustment', '프로필 잔액 수정', name)],
      }
    })
  }

  const deleteProfile = (id: string) => {
    if (data.game?.seats.some((s) => s.profileId === id)) {
      setToast('진행 중인 게임에서 퇴장·정산한 뒤 삭제할 수 있습니다.')
      return
    }
    update((d) => {
      const profile = d.profiles.find((p) => p.id === id)
      if (!profile) return d
      return {
        ...d,
        profiles: d.profiles.filter((p) => p.id !== id),
        transactions: [
          ...d.transactions.map((t) => t.profileId === id && !t.profileName ? { ...t, profileName: profile.name } : t),
          ...(profile.balance > 0 ? [tx(id, -profile.balance, 'adjustment', '프로필 삭제로 잔액 종료', profile.name)] : []),
        ],
      }
    })
  }

  const createGame = (smallBlind: number, bigBlind: number, entries: { profile: Profile; buyIn: number }[], firstSmallBlindId: string) => {
    if (entries.length < 2) return setToast('두 명 이상을 선택해주세요.')
    if (smallBlind <= 0 || bigBlind <= smallBlind) return setToast('빅 블라인드는 스몰 블라인드보다 커야 합니다.')
    if (entries.some((e) => e.buyIn <= 0 || e.buyIn > e.profile.balance)) return setToast('바이인 금액과 잔액을 확인해주세요.')
    const slots = SEAT_SLOTS[entries.length]
    const seats: Seat[] = entries.map(({ profile, buyIn }, index) => ({
      id: uid(), profileId: profile.id, name: profile.name, seat: slots[index], stack: buyIn,
      state: 'active', sittingOutNextHand: false, joinedAtHand: 0, streetBet: 0, totalBet: 0,
      buyInTotal: buyIn, handsPlayed: 0, handsWon: 0,
    }))
    const firstSmallBlindIndex = Math.max(0, entries.findIndex((entry) => entry.profile.id === firstSmallBlindId))
    const buttonIndex = entries.length === 2 ? firstSmallBlindIndex : (firstSmallBlindIndex - 1 + entries.length) % entries.length
    const game: Game = {
      id: uid(), createdAt: now(), smallBlind, bigBlind, phase: 'between-hands', street: 'preflop', handNumber: 0,
      buttonSeat: seats[buttonIndex].seat, smallBlindSeat: null, bigBlindSeat: null, currentActorId: null, currentBet: 0, minRaise: bigBlind, seats,
      communityCardsRevealed: 0, awaitingBoard: false, needsAction: [], lastActedBet: {}, logs: [],
      participatingProfileIds: entries.map((entry) => entry.profile.id), departedSeats: [], layoutVersion: 2,
    }
    update((d) => ({
      ...d,
      profiles: d.profiles.map((p) => {
        const entry = entries.find((e) => e.profile.id === p.id)
        return entry ? { ...p, balance: p.balance - entry.buyIn } : p
      }),
      transactions: [...d.transactions, ...entries.map((e) => tx(e.profile.id, -e.buyIn, 'buy-in', '게임 바이인', e.profile.name))],
      game,
    }))
    setUndoGame(null)
    setScreen('table')
  }

  const act = (action: PokerAction) => {
    if (!data.game) return
    try {
      const previous = data.game
      const next = applyAction(previous, action)
      setUndoGame(next.phase === 'playing' && next.street === previous.street ? previous : null)
      update((d) => ({ ...d, game: next }))
      playPokerSound(next.phase === 'between-hands' ? 'win' : next.phase === 'showdown' ? 'showdown' : action.type === 'fold' ? 'fold' : action.type === 'check' ? 'check' : 'chip')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '행동을 처리하지 못했습니다.')
    }
  }

  const beginHand = () => {
    if (!data.game) return
    try {
      const next = startHand(data.game)
      update((d) => ({ ...d, game: next }))
      setUndoGame(null)
      playPokerSound('deal')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '핸드를 시작하지 못했습니다.')
    }
  }

  const settleHand = (selections: Record<string, string[]>) => {
    if (!data.game) return
    try {
      const settled = settleShowdown(data.game, selections)
      update((d) => ({ ...d, game: settled }))
      setUndoGame(null)
      playPokerSound('win')
      setToast('팟 지급이 완료됐습니다. 다음 핸드를 시작할 수 있어요.')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '승자 정산을 완료하지 못했습니다.')
    }
  }

  const confirmBoard = () => {
    if (!data.game) return
    try {
      const next = confirmBoardDealt(data.game)
      update((d) => ({ ...d, game: next }))
      playPokerSound('deal')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '공용 카드 단계를 진행하지 못했습니다.')
    }
  }

  const closeAndSettleGame = (game: Game) => {
    const finished = { ...game, seats: [...(game.departedSeats ?? []), ...game.seats], phase: 'finished' as const }
    update((d) => ({
      ...d,
      profiles: d.profiles.map((p) => {
        const seat = game.seats.find((s) => s.profileId === p.id)
        return seat ? { ...p, balance: p.balance + seat.stack } : p
      }),
      transactions: [...d.transactions, ...game.seats.map((s) => tx(s.profileId, s.stack, 'cash-out', `게임 #${game.id.slice(0, 5)} 정산`, s.name))],
      archives: [finished, ...d.archives].slice(0, 30),
      game: null,
    }))
    setScreen('home')
  }

  const finishGame = () => {
    const game = data.game
    if (!game || game.phase !== 'between-hands') return
    if (!window.confirm('모든 테이블 칩을 프로필 잔액으로 돌려주고 게임을 종료할까요?')) return
    closeAndSettleGame(game)
  }

  const cancelCurrentHand = () => {
    if (!data.game) return
    try {
      const cancelled = voidCurrentHand(data.game)
      update((d) => ({ ...d, game: cancelled }))
      setUndoGame(null)
      playPokerSound('fold')
      setToast('현재 핸드를 무효 처리했습니다. 같은 블라인드 위치에서 다시 시작할 수 있어요.')
    } catch (error) {
      setToast(error instanceof Error ? error.message : '핸드를 무효 처리하지 못했습니다.')
    }
  }

  const emergencyEndGame = () => {
    if (!data.game) return
    try {
      const cancelled = voidCurrentHand(data.game)
      setUndoGame(null)
      closeAndSettleGame(cancelled)
    } catch (error) {
      setToast(error instanceof Error ? error.message : '게임을 종료하지 못했습니다.')
    }
  }

  const cashOutSeat = (seatId: string) => {
    const game = data.game
    const seat = game?.seats.find((s) => s.id === seatId)
    if (!game || !seat || game.phase !== 'between-hands') return
    if (!window.confirm(`${seat.name}님이 ${fmt(seat.stack)}를 가지고 퇴장할까요?`)) return
    update((d) => ({
      ...d,
      profiles: d.profiles.map((p) => p.id === seat.profileId ? { ...p, balance: p.balance + seat.stack } : p),
      transactions: [...d.transactions, tx(seat.profileId, seat.stack, 'cash-out', '게임 중 퇴장', seat.name)],
      game: { ...game, departedSeats: [...(game.departedSeats ?? []), seat], seats: game.seats.filter((s) => s.id !== seatId) },
    }))
  }

  const rebuySeat = (seatId: string, amount: number) => {
    const game = data.game
    const seat = game?.seats.find((candidate) => candidate.id === seatId)
    const profile = seat ? data.profiles.find((candidate) => candidate.id === seat.profileId) : undefined
    if (!game || !seat || !profile || game.phase !== 'between-hands') {
      setToast('리바이는 핸드가 끝난 뒤에만 할 수 있습니다.')
      return
    }
    if (amount <= 0 || amount > profile.balance) {
      setToast(`${seat.name}님의 프로필 잔액 안에서 리바이 금액을 입력해주세요.`)
      return
    }
    update((d) => ({
      ...d,
      profiles: d.profiles.map((candidate) => candidate.id === profile.id ? { ...candidate, balance: candidate.balance - amount } : candidate),
      transactions: [...d.transactions, tx(profile.id, -amount, 'buy-in', `게임 중 리바이 · 핸드 #${game.handNumber} 후`, seat.name)],
      game: { ...game, seats: game.seats.map((candidate) => candidate.id === seatId ? { ...candidate, stack: candidate.stack + amount, buyInTotal: (candidate.buyInTotal ?? candidate.stack) + amount, state: candidate.sittingOutNextHand ? 'sitting-out' : 'active' } : candidate) },
    }))
    setToast(`${seat.name}님이 ${fmt(amount)} 리바이했습니다.`)
  }

  const header = (
    <header className="app-header">
      <button className="brand" onClick={() => setScreen('home')} aria-label="홈으로 이동"><span>♠</span> Poker Pilot</button>
      <nav>
        <button onClick={() => setScreen('home')}>홈</button>
        <button onClick={() => setHelp(true)}>족보</button>
        <button onClick={() => setScreen('history')}>기록</button>
        {data.game && <button onClick={() => setScreen('table')}>테이블</button>}
      </nav>
    </header>
  )

  return <div className="app">
    {header}
    <main>
      {screen === 'home' && <Home profiles={data.profiles} game={data.game} archives={data.archives} onAdd={addProfile} onUpdate={updateProfile} onDelete={deleteProfile} onSetup={() => setScreen('setup')} onContinue={() => setScreen('table')} />}
      {screen === 'setup' && <GameSetup profiles={data.profiles} onCancel={() => setScreen('home')} onCreate={createGame} />}
      {screen === 'table' && data.game && <Table game={data.game} profiles={data.profiles} onAct={act} onBegin={beginHand}
        onSetGame={(game) => update((d) => ({ ...d, game }))} onFinish={finishGame} onCashOut={cashOutSeat} onRebuy={rebuySeat}
        onVoidHand={cancelCurrentHand} onEmergencyEnd={emergencyEndGame}
        onUndo={() => { if (undoGame) { update((d) => ({ ...d, game: undoGame })); setUndoGame(null) } }} canUndo={!!undoGame}
        onConfirmBoard={confirmBoard}
        onSettle={settleHand}
        onJoin={(profile, buyIn) => {
          const game = data.game!
          if (game.participatingProfileIds?.includes(profile.id)) return setToast('이 게임에 이미 참가했던 프로필은 다시 참가할 수 없습니다.')
          const occupied = new Set(game.seats.map((s) => s.seat))
          const position = [0, 1, 2, 3, 4, 5].find((n) => !occupied.has(n)) ?? game.seats.length
          const seat: Seat = { id: uid(), profileId: profile.id, name: profile.name, seat: position, stack: buyIn, state: 'sitting-out', sittingOutNextHand: false, joinedAtHand: game.handNumber + 1, streetBet: 0, totalBet: 0, owesEntryBlind: true, buyInTotal: buyIn, handsPlayed: 0, handsWon: 0 }
          update((d) => ({ ...d, profiles: d.profiles.map((p) => p.id === profile.id ? { ...p, balance: p.balance - buyIn } : p), transactions: [...d.transactions, tx(profile.id, -buyIn, 'buy-in', '게임 중 참가', profile.name)], game: { ...game, seats: [...game.seats, seat], participatingProfileIds: [...(game.participatingProfileIds ?? game.seats.map((s) => s.profileId)), profile.id] } }))
        }} />}
      {screen === 'history' && <History data={data} onBack={() => setScreen(data.game ? 'table' : 'home')} />}
    </main>
    {help && <HandHelp onClose={() => setHelp(false)} />}
    {toast && <div className="toast">{toast}</div>}
  </div>
}

function Home({ profiles, game, archives, onAdd, onUpdate, onDelete, onSetup, onContinue }: {
  profiles: Profile[]; game: Game | null; archives: Game[]; onAdd: (n: string, b: number) => void; onUpdate: (id: string, n: string, b: number) => void; onDelete: (id: string) => void; onSetup: () => void; onContinue: () => void
}) {
  const [name, setName] = useState('')
  const [balance, setBalance] = useState('1000')
  const [editing, setEditing] = useState<Profile | null>(null)
  return <div className="page narrow">
    <section className="hero">
      <p className="eyebrow">YOUR HOME POKER TABLE</p>
      <h1>칩 계산은 맡기고,<br /><em>플레이에 집중하세요.</em></h1>
      <p>실물 카드만 준비하세요. 블라인드, 액션 순서, 팟과 정산은 Poker Pilot이 관리합니다.</p>
      {game ? <button className="primary jumbo" onClick={onContinue}>진행 중인 게임 이어하기 →</button> : <button className="primary jumbo" disabled={profiles.length < 2} onClick={onSetup}>새 게임 만들기 →</button>}
    </section>
    <section className="panel">
      <div className="section-title"><div><span className="eyebrow">PLAYERS</span><h2>플레이어 프로필</h2></div><span>{profiles.length}명</span></div>
      <div className="profile-grid">
        {profiles.map((profile) => <ProfileCard key={profile.id} profile={profile} stats={playerStats(profile.id, archives, game)} onEdit={() => setEditing(profile)} />)}
        <form className="profile-card add-card" onSubmit={(e) => { e.preventDefault(); if (name.trim() && parseMoney(balance) >= 0) { onAdd(name.trim(), parseMoney(balance)); setName('') } }}>
          <strong>새 플레이어</strong>
          <input aria-label="플레이어 이름" placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} maxLength={16} />
          <label>시작 잔액 ($)<input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} /></label>
          <button className="secondary" type="submit">프로필 추가</button>
        </form>
      </div>
    </section>
    {editing && <ProfileEditor profile={editing} stats={playerStats(editing.id, archives, game)} inGame={!!game?.seats.some((s) => s.profileId === editing.id)} onClose={() => setEditing(null)} onSave={(nextName, nextBalance) => { onUpdate(editing.id, nextName, nextBalance); setEditing(null) }} onDelete={() => { onDelete(editing.id); setEditing(null) }} />}
  </div>
}

function ProfileCard({ profile, stats, onEdit }: { profile: Profile; stats: PlayerStats; onEdit: () => void }) {
  return <article className="profile-card">
    <div className="avatar">{profile.name.slice(0, 1).toUpperCase()}</div>
    <div><strong>{profile.name}</strong><small>게임 {stats.games}회 · {stats.gameWins}승 {stats.gameLosses}패 · 핸드 {stats.handsWon}승</small><b className="amount-with-chip"><ChipVisual amount={profile.balance} small />{fmt(profile.balance)}</b></div>
    <button className="icon-button" aria-label={`${profile.name} 프로필 편집`} onClick={onEdit}>•••</button>
  </article>
}

function ProfileEditor({ profile, stats, inGame, onClose, onSave, onDelete }: { profile: Profile; stats: PlayerStats; inGame: boolean; onClose: () => void; onSave: (name: string, balance: number) => void; onDelete: () => void }) {
  const [name, setName] = useState(profile.name)
  const [balance, setBalance] = useState(money(profile.balance))
  const numericBalance = Number(balance.replace(/,/g, ''))
  const valid = name.trim().length > 0 && Number.isFinite(numericBalance) && numericBalance >= 0
  return <div className="overlay profile-editor-overlay" onMouseDown={onClose}><section className="profile-editor" onMouseDown={(e) => e.stopPropagation()}>
    <div className="drawer-head"><div><span className="eyebrow">PLAYER PROFILE</span><h2>프로필 편집</h2></div><button onClick={onClose}>×</button></div>
    <div className="profile-editor-hero"><div className="avatar large">{(name || profile.name).slice(0, 1).toUpperCase()}</div><div><b>{name || '이름 없음'}</b><span>{inGame ? '현재 게임 참가 중' : '게임 대기 중'}</span></div></div>
    <div className="profile-stats"><div><small>현재 잔액</small><b>{fmt(parseMoney(balance))}</b></div><div><small>완료 게임 손익</small><b className={stats.net >= 0 ? 'plus' : 'minus'}>{signedFmt(stats.net)}</b></div><div><small>게임 승패</small><b>{stats.gameWins}승 {stats.gameLosses}패 {stats.gameDraws}무</b></div><div><small>핸드 승패</small><b>{stats.handsWon}승 {Math.max(0, stats.handsPlayed - stats.handsWon)}패</b></div><div><small>핸드 승률</small><b>{stats.handsPlayed ? ((stats.handsWon / stats.handsPlayed) * 100).toFixed(1) : '0.0'}%</b></div><div><small>완료한 게임</small><b>{stats.games}회</b></div></div>
    <p className="stats-note">게임 승패는 총 바이인 대비 최종 정산액으로 계산합니다. 스플릿을 포함해 팟을 받은 핸드는 승리로 기록합니다.</p>
    <form onSubmit={(e) => { e.preventDefault(); if (valid) onSave(name.trim(), parseMoney(balance)) }}>
      <label>플레이어 이름<input autoFocus maxLength={16} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>보유 잔액 ($)<input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} /><small>기존 잔액과의 차액은 장부에 자동 기록됩니다.</small></label>
      <button className="primary" disabled={!valid} type="submit">변경사항 저장</button>
    </form>
    <div className="profile-danger"><div><b>프로필 삭제</b><small>{inGame ? '진행 중인 게임에서 먼저 퇴장·정산해야 합니다.' : '과거 게임 기록에는 당시 이름이 그대로 남습니다.'}</small></div><button disabled={inGame} onClick={() => window.confirm(`${profile.name} 프로필을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`) && onDelete()}>삭제</button></div>
  </section></div>
}

function GameSetup({ profiles, onCancel, onCreate }: { profiles: Profile[]; onCancel: () => void; onCreate: (sb: number, bb: number, entries: { profile: Profile; buyIn: number }[], firstSmallBlindId: string) => void }) {
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [order, setOrder] = useState<string[]>([])
  const [firstSmallBlind, setFirstSmallBlind] = useState('')
  const [sb, setSb] = useState('1')
  const [bb, setBb] = useState('2')
  const entries = order.map((id) => profiles.find((profile) => profile.id === id)).filter((profile): profile is Profile => !!profile).map((profile) => ({ profile, buyIn: parseMoney(selected[profile.id]) }))
  const selectedFirstSmallBlind = entries.some((entry) => entry.profile.id === firstSmallBlind) ? firstSmallBlind : entries[0]?.profile.id ?? ''
  const move = (id: string, direction: -1 | 1) => setOrder((current) => {
    const from = current.indexOf(id)
    const to = from + direction
    if (from < 0 || to < 0 || to >= current.length) return current
    const next = [...current]; [next[from], next[to]] = [next[to], next[from]]
    return next
  })
  return <div className="page narrow setup-page">
    <button className="back" onClick={onCancel}>← 돌아가기</button>
    <p className="eyebrow">NEW CASH GAME</p><h1>게임 설정</h1>
    <section className="panel blind-panel">
      <h2>블라인드</h2><div className="field-row"><label>스몰 블라인드 ($)<input inputMode="decimal" value={sb} onChange={(e) => setSb(e.target.value)} /></label><span>/</span><label>빅 블라인드 ($)<input inputMode="decimal" value={bb} onChange={(e) => setBb(e.target.value)} /></label></div>
    </section>
    <section className="panel">
      <div className="section-title"><div><span className="eyebrow">2–6 PLAYERS</span><h2>참가자와 바이인</h2></div><b>{entries.length}/6</b></div>
      {entries.length > 0 && <div className="seat-order-help">아래쪽 좌석부터 오른쪽 방향 순서입니다. 화살표로 실제 착석 순서에 맞추세요.</div>}
      <div className="entry-list">{profiles.map((p) => {
        const checked = selected[p.id] !== undefined
        return <div className={`entry ${checked ? 'selected' : ''}`} key={p.id}>
          <button className="check" onClick={() => { setSelected((s) => { const n = { ...s }; if (checked) delete n[p.id]; else if (Object.keys(n).length < 6) n[p.id] = money(Math.min(p.balance, 10_000)); return n }); setOrder((current) => checked ? current.filter((id) => id !== p.id) : current.length < 6 ? [...current, p.id] : current) }}>{checked ? order.indexOf(p.id) + 1 : '+'}</button>
          <div><strong>{p.name}</strong><small>잔액 {fmt(p.balance)}</small></div>
          {checked && <label>바이인 $<input inputMode="decimal" value={selected[p.id]} onChange={(e) => setSelected((s) => ({ ...s, [p.id]: e.target.value }))} /></label>}
          {checked && <div className="order-buttons"><button disabled={order.indexOf(p.id) === 0} onClick={() => move(p.id, -1)}>←</button><button disabled={order.indexOf(p.id) === order.length - 1} onClick={() => move(p.id, 1)}>→</button></div>}
        </div>
      })}</div>
      {entries.length >= 2 && <label className="first-blind-select">첫 스몰 블라인드<select value={selectedFirstSmallBlind} onChange={(e) => setFirstSmallBlind(e.target.value)}>{entries.map(({ profile }) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>}
    </section>
    <button className="primary jumbo sticky-action" disabled={entries.length < 2} onClick={() => onCreate(parseMoney(sb), parseMoney(bb), entries, selectedFirstSmallBlind)}>테이블 열기</button>
  </div>
}

function BoardStatus({ count }: { count: number }) {
  return <div className="board-status" aria-label={`공용 카드 ${count}장 공개됨`}><span>공용 카드</span><div>{Array.from({ length: 5 }, (_, index) => <i className={index < count ? 'revealed' : ''} key={index}>{index < count ? '✓' : '?'}</i>)}</div><b>{count}/5</b></div>
}

function BoardReveal({ game, onConfirm }: { game: Game; onConfirm: () => void }) {
  const current = game.communityCardsRevealed ?? 0
  const target = game.phase === 'showdown' || game.street === 'river' ? 5 : game.street === 'turn' ? 4 : 3
  const needed = target - current
  const title = game.phase === 'showdown' ? '남은 공용 카드를 펼치세요' : game.street === 'flop' ? '플랍을 펼칠 차례예요' : game.street === 'turn' ? '턴 카드를 펼칠 차례예요' : '리버 카드를 펼칠 차례예요'
  const instruction = current === 0 && target === 5
    ? '1장 버리기 → 플랍 3장 → 1장 버리기 → 턴 1장 → 1장 버리기 → 리버 1장'
    : current === 3 && target === 5
      ? '1장 버리기 → 턴 1장 → 1장 버리기 → 리버 1장'
      : `맨 위 카드 1장을 버린 뒤 공용 카드 ${needed}장을 펼치세요.`
  return <section className="board-reveal-panel">
    <span className="deal-label">DEAL THE BOARD</span>
    <h2>{title}</h2>
    <p>{instruction}</p>
    <div className="board-cards">{Array.from({ length: 5 }, (_, index) => {
      const revealed = index < current
      const revealNow = index >= current && index < target
      return <div className={revealed ? 'revealed' : revealNow ? 'reveal-now' : ''} key={index}><b>{revealed ? '✓' : revealNow ? index + 1 : '?'}</b><small>{revealed ? '공개됨' : revealNow ? '지금 공개' : '나중에'}</small></div>
    })}</div>
    <div className="burn-note"><b>번 카드란?</b> 덱 맨 위 1장을 앞면을 보이지 않고 옆에 두는 카드입니다.</div>
    <button className="primary" onClick={onConfirm}>공용 카드 {needed}장 펼쳤어요 → {game.phase === 'showdown' ? '승자 선택' : '베팅 계속'}</button>
    <small className="board-total">확인 후 테이블에는 공용 카드가 총 {target}장 있어야 합니다.</small>
  </section>
}

function Table({ game, profiles, onAct, onBegin, onSetGame, onFinish, onCashOut, onRebuy, onVoidHand, onEmergencyEnd, onUndo, canUndo, onConfirmBoard, onSettle, onJoin }: {
  game: Game; profiles: Profile[]; onAct: (a: PokerAction) => void; onBegin: () => void; onSetGame: (g: Game) => void; onFinish: () => void; onCashOut: (id: string) => void; onRebuy: (id: string, amount: number) => void; onVoidHand: () => void; onEmergencyEnd: () => void; onUndo: () => void; canUndo: boolean; onConfirmBoard: () => void; onSettle: (s: Record<string, string[]>) => void; onJoin: (p: Profile, b: number) => void
}) {
  const [logs, setLogs] = useState(false)
  const [manage, setManage] = useState(false)
  const [emergency, setEmergency] = useState(false)
  const seats = [...game.seats].sort((a, b) => a.seat - b.seat)
  const actor = seats.find((s) => s.id === game.currentActorId)
  const actorRotation = seatLayout(actor?.seat ?? 0, 6).rotation
  const activeCount = seats.filter((s) => !s.sittingOutNextHand && s.stack > 0).length
  const positions = blindPositions(game)
  return <div className="table-page">
    <div className="table-toolbar">
      <div><span>핸드 #{game.handNumber || '—'}</span><div className="blind-summary"><i>SB</i><b>{fmt(game.smallBlind)}</b><i>BB</i><b>{fmt(game.bigBlind)}</b></div>{game.handNumber > 0 && <BoardStatus count={game.communityCardsRevealed ?? 0} />}</div>
      <div>{(game.phase === 'playing' || game.phase === 'showdown') && <button className="emergency-button" onClick={() => setEmergency(true)}>⚠ 긴급 정리</button>}<button onClick={onUndo} disabled={!canUndo}>↶ 실행 취소</button><button onClick={() => setLogs(true)}>☰ 액션 기록</button>{game.phase === 'between-hands' && <button onClick={() => setManage(true)}>⚙ 플레이어</button>}</div>
    </div>
    <div className="felt-wrap">
      <div className="felt">
        {seats.map((seat) => <SeatCard key={seat.id} seat={seat} game={game} positions={positions} />)}
        <section className={`table-center ${(game.phase === 'playing' || game.awaitingBoard) ? 'action-open' : ''}`}>
          <div className="street-pill">{game.phase === 'between-hands' ? '핸드 준비' : streetName(game.street)}</div>
          <small>현재 팟</small><PotPile amount={potTotal(game)} bigBlind={game.bigBlind} /><div className="pot">{fmt(potTotal(game))}</div>
          <div className="table-bank">테이블 총 칩 {fmt(game.seats.reduce((sum, seat) => sum + seat.stack, 0) + potTotal(game))}</div>
          {game.phase === 'between-hands' && <div className="between">
            {game.handNumber > 0 && <div className="settled-badge">✓ 정산 완료</div>}
            <BlindGuide game={game} positions={positions} />
            <p>{game.repeatButtonNextHand ? `핸드 #${game.handNumber}은 무효입니다. 같은 블라인드 위치에서 다시 진행합니다.` : game.handNumber === 0 ? '스몰·빅 블라인드 위치를 확인하고 첫 핸드를 시작하세요.' : `핸드 #${game.handNumber} 정산이 끝났습니다. 블라인드는 다음 좌석으로 이동합니다.`}</p>
            {activeCount >= 2 ? <button className="primary next-hand" onClick={onBegin}>카드를 나누고 {game.repeatButtonNextHand ? '같은 핸드 다시' : game.handNumber ? '다음' : '첫'} 핸드 시작 →</button> : <div className="not-enough-players"><b>다음 핸드를 시작할 수 없습니다.</b><small>칩이 있고 자리 비움이 아닌 플레이어가 2명 이상 필요합니다. 플레이어 관리에서 확인하거나 게임을 종료해 정산해주세요.</small></div>}
          </div>}
          {game.phase === 'showdown' && !game.awaitingBoard && <Showdown game={game} onSettle={onSettle} />}
        </section>
        {game.awaitingBoard ? <BoardReveal game={game} onConfirm={onConfirmBoard} /> : game.phase === 'playing' && actor && <ActionPanel game={game} actor={actor} rotation={actorRotation} onAct={onAct} />}
      </div>
    </div>
    {logs && <Drawer title="액션 기록" onClose={() => setLogs(false)}><div className="log-list">{[...game.logs].reverse().map((log) => <div key={log.id}><span>#{log.hand} · {streetName(log.street)}</span><b>{log.text}</b></div>)}</div></Drawer>}
    {manage && <ManagePlayers game={game} profiles={profiles} onClose={() => setManage(false)} onSetGame={onSetGame} onCashOut={onCashOut} onRebuy={onRebuy} onJoin={onJoin} onFinish={onFinish} />}
    {emergency && <EmergencyPanel game={game} onClose={() => setEmergency(false)} onVoid={() => { setEmergency(false); onVoidHand() }} onEnd={() => { setEmergency(false); onEmergencyEnd() }} />}
  </div>
}

function seatLayout(index: number, count: number) {
  const angle = (index * 360) / count
  // Keep the wider seat cards safely inside the felt on tablet-sized tables.
  const x = 50 + 40 * Math.sin(angle * Math.PI / 180)
  const y = 50 + 38 * Math.cos(angle * Math.PI / 180)
  const rotation = y < 30 ? 180 : x < 25 ? 90 : x > 75 ? -90 : 0
  return { x, y, rotation }
}

type BlindPositions = { button: number | null; smallBlind: number | null; bigBlind: number | null; upcoming: boolean }

function blindPositions(game: Game): BlindPositions {
  if (game.phase !== 'between-hands') return { button: game.buttonSeat, smallBlind: game.smallBlindSeat ?? null, bigBlind: game.bigBlindSeat ?? null, upcoming: false }
  const players = [...game.seats].filter((s) => !s.sittingOutNextHand && s.stack > 0).sort((a, b) => a.seat - b.seat)
  if (players.length < 2) return { button: null, smallBlind: null, bigBlind: null, upcoming: true }
  const next = (from: number) => players.find((s) => s.seat > from) ?? players[0]
  const keepButton = (game.handNumber === 0 || game.repeatButtonNextHand) && game.buttonSeat !== null && players.some((s) => s.seat === game.buttonSeat)
  const button = keepButton ? players.find((s) => s.seat === game.buttonSeat)! : next(game.buttonSeat ?? -1)
  const smallBlind = players.length === 2 ? button : next(button.seat)
  const bigBlind = next(smallBlind.seat)
  return { button: button.seat, smallBlind: smallBlind.seat, bigBlind: bigBlind.seat, upcoming: true }
}

function BlindGuide({ game, positions }: { game: Game; positions: BlindPositions }) {
  const name = (seat: number | null) => game.seats.find((s) => s.seat === seat)?.name ?? '—'
  return <div className="blind-guide">
    <div className="blind-step sb-step"><i>SB</i><span><small>스몰 블라인드</small><b>{name(positions.smallBlind)} · {fmt(game.smallBlind)}</b></span></div><strong>→</strong>
    <div className="blind-step bb-step"><i>BB</i><span><small>빅 블라인드</small><b>{name(positions.bigBlind)} · {fmt(game.bigBlind)}</b></span></div>
  </div>
}

function SeatCard({ seat, game, positions }: { seat: Seat; game: Game; positions: BlindPositions }) {
  const { x, y, rotation } = seatLayout(seat.seat, 6)
  const smallBlind = seat.seat === positions.smallBlind
  const bigBlind = seat.seat === positions.bigBlind
  return <article className={`seat-card ${game.currentActorId === seat.id ? 'current' : ''} ${seat.state}`} style={{ left: `${x}%`, top: `${y}%`, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}>
    <div className="seat-top"><span className="avatar mini">{seat.name[0]}</span><strong>{seat.name}</strong></div>
    <div className="seat-body">
      <div className="seat-main"><div className="stack"><ChipVisual amount={seat.stack} small /><b>{fmt(seat.stack)}</b></div><div className="seat-meta"><span>{(seat.stack / game.bigBlind).toFixed(1)} BB</span><span>핸드 {fmt(seat.totalBet)}</span></div></div>
      {(smallBlind || bigBlind || seat.streetBet > 0) && <div className="seat-markers">
        {(smallBlind || bigBlind) && <span className={`seat-blind ${bigBlind ? 'big' : 'small'}`}>{bigBlind ? `BB ${fmt(game.bigBlind)}` : `SB ${fmt(game.smallBlind)}`}</span>}
        {seat.streetBet > 0 && <span className="seat-bet"><ChipVisual amount={seat.streetBet} small />베팅 {fmt(seat.streetBet)}</span>}
      </div>}
    </div>
    {seat.state !== 'active' && <span className="state-label">{{ folded: '폴드', 'all-in': '올인', 'sitting-out': '자리 비움', active: '' }[seat.state]}</span>}
  </article>
}

function ActionPanel({ game, actor, rotation, onAct }: { game: Game; actor: Seat; rotation: number; onAct: (a: PokerAction) => void }) {
  const actions = availableActions(game, actor.id)
  const owing = Math.max(0, game.currentBet - actor.streetBet)
  const minimum = game.currentBet === 0 ? game.bigBlind : game.currentBet + game.minRaise
  const max = actor.streetBet + actor.stack
  const [amount, setAmount] = useState(money(Math.min(max, minimum)))
  useEffect(() => setAmount(money(Math.min(max, minimum))), [actor.id, minimum, max])
  const raiseType = game.currentBet === 0 ? 'bet' : 'raise'
  const potRaise = Math.min(max, game.currentBet + potTotal(game) + owing)
  const halfPotRaise = Math.min(max, game.currentBet + Math.round((potTotal(game) + owing) / 2))
  const target = parseMoney(amount)
  const additional = Math.max(0, Math.min(actor.stack, target - actor.streetBet))
  const afterRaise = actor.stack - additional
  const callAmount = Math.min(owing, actor.stack)
  const submitRaise = () => onAct({ type: raiseType, total: parseMoney(amount) })
  const sideFacing = Math.abs(rotation) === 90
  return <div className={`action-panel floating ${sideFacing ? 'side-facing' : 'end-facing'}`} style={{ transform: `translate(-50%, -50%) rotate(${rotation}deg)` }}>
    <div className="action-heading">
      <div className="turn"><span>{actor.name}님의 차례</span><small>{owing ? `${fmt(owing)}을 더 내면 콜할 수 있어요.` : '추가 금액 없이 체크할 수 있어요.'}</small></div>
      <div className="action-pot"><small>{streetName(game.street)} · 현재 팟</small><b><PotPile amount={potTotal(game)} bigBlind={game.bigBlind} compact />{fmt(potTotal(game))}</b><em>현재 최고 베팅 {fmt(game.currentBet)}</em></div>
    </div>
    <div className="chip-details">
      <div><small>보유 칩</small><b>{fmt(actor.stack)}</b><em>{(actor.stack / game.bigBlind).toFixed(1)} BB</em></div>
      <div><small>이번 핸드 투입</small><b>{fmt(actor.totalBet)}</b><em>현재 거리 {fmt(actor.streetBet)}</em></div>
      <div><small>콜 필요액</small><b>{fmt(callAmount)}</b><em>콜 후 {fmt(actor.stack - callAmount)}</em></div>
    </div>
    <div className="action-buttons">
      <button className="danger" onClick={() => onAct({ type: 'fold' })}>폴드<small>핸드 포기</small></button>
      {actions.includes('check') ? <button onClick={() => onAct({ type: 'check' })}>체크<small>그대로 넘기기</small></button> : <button onClick={() => onAct({ type: 'call' })}>콜 {fmt(Math.min(owing, actor.stack))}<small>금액 맞추기</small></button>}
      {(actions.includes('bet') || actions.includes('raise')) && <button className="gold" onClick={submitRaise}>{game.currentBet ? '레이즈' : '벳'}<small>총 {fmt(target)} · 추가 {fmt(additional)}</small></button>}
      {actions.includes('all-in') && <button className="allin" onClick={() => window.confirm(`${actor.name}님이 ${fmt(actor.stack)}을 모두 베팅할까요?`) && onAct({ type: 'all-in' })}>올인<small>{fmt(actor.stack)}</small></button>}
    </div>
    {(actions.includes('bet') || actions.includes('raise')) && <div className="bet-controls">
      <label>총 베팅액 $<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /><span>베팅 후 {fmt(afterRaise)}</span></label>
      <button onClick={() => setAmount(money(Math.min(max, minimum)))}>최소</button>
      <button onClick={() => setAmount(money(Math.max(minimum, halfPotRaise)))}>½ 팟</button>
      <button onClick={() => setAmount(money(Math.max(minimum, potRaise)))}>팟</button>
    </div>}
  </div>
}

function Showdown({ game, onSettle }: { game: Game; onSettle: (s: Record<string, string[]>) => void }) {
  const pots = buildSidePots(game)
  const initial = Object.fromEntries(pots.filter((p) => p.automatic).map((p) => [p.id, p.eligibleSeatIds]))
  const [selected, setSelected] = useState<Record<string, string[]>>(initial)
  const ready = pots.every((pot) => pot.automatic || (selected[pot.id]?.length ?? 0) > 0)
  return <div className="showdown">
    <h2>승자를 선택하세요</h2><p>동률이면 같은 팟에서 여러 명을 선택하세요.</p>
    {pots.map((pot, index) => <div className="pot-choice" key={pot.id}>
      <b>{pot.uncalledReturn ? '콜되지 않은 베팅 반환' : index === 0 ? '메인 팟' : `사이드팟 ${index}`} · {fmt(pot.amount)}</b>
      <div>{pot.eligibleSeatIds.map((id) => {
        const seat = game.seats.find((s) => s.id === id)!
        const checked = selected[pot.id]?.includes(id)
        return <button disabled={pot.automatic} className={checked ? 'chosen' : ''} key={id} onClick={() => setSelected((all) => ({ ...all, [pot.id]: checked ? all[pot.id].filter((x) => x !== id) : [...(all[pot.id] ?? []), id] }))}>{checked ? '✓ ' : ''}{seat.name}</button>
      })}</div>
    </div>)}
    <button className="primary" disabled={!ready} onClick={() => onSettle(selected)}>팟 지급 확정</button>
  </div>
}

function ManagePlayers({ game, profiles, onClose, onSetGame, onCashOut, onRebuy, onJoin, onFinish }: { game: Game; profiles: Profile[]; onClose: () => void; onSetGame: (g: Game) => void; onCashOut: (id: string) => void; onRebuy: (id: string, amount: number) => void; onJoin: (p: Profile, b: number) => void; onFinish: () => void }) {
  const [joinId, setJoinId] = useState('')
  const [buyIn, setBuyIn] = useState('100')
  const [rebuySeatId, setRebuySeatId] = useState('')
  const [rebuyAmount, setRebuyAmount] = useState('100')
  const participated = new Set(game.participatingProfileIds ?? game.seats.map((s) => s.profileId))
  const available = profiles.filter((p) => !participated.has(p.id))
  const rebuySeat = game.seats.find((seat) => seat.id === rebuySeatId)
  const rebuyProfile = profiles.find((profile) => profile.id === rebuySeat?.profileId)
  const rebuyValue = parseMoney(rebuyAmount)
  return <Drawer title="플레이어 관리" onClose={onClose}>
    <p className="muted">리바이와 변경 사항은 다음 핸드부터 적용됩니다. 중도 참가자와 자리 비움 후 복귀자는 다음 핸드에 최대 1BB를 자동 포스트합니다.</p>
    <div className="manage-list">{game.seats.map((seat) => <div key={seat.id}><div><strong>{seat.name}</strong><small>{fmt(seat.stack)}{seat.owesEntryBlind ? ` · 복귀 BB ${fmt(game.bigBlind)} 예정` : ''}</small></div><button className="rebuy-button" onClick={() => { setRebuySeatId(seat.id); setRebuyAmount('100') }}>{seat.stack > 0 ? '칩 추가' : '리바이'}</button><button onClick={() => onSetGame({ ...game, seats: game.seats.map((s) => s.id === seat.id ? { ...s, sittingOutNextHand: !s.sittingOutNextHand, owesEntryBlind: s.sittingOutNextHand ? true : s.owesEntryBlind } : s) })}>{seat.sittingOutNextHand ? '복귀 예약' : '자리 비움'}</button><button className="danger-text" onClick={() => onCashOut(seat.id)}>퇴장·정산</button></div>)}</div>
    {rebuySeat && rebuyProfile && <div className="rebuy-box"><div><h3>{rebuySeat.name} 리바이</h3><small>프로필 잔액 {fmt(rebuyProfile.balance)} · 현재 칩 {fmt(rebuySeat.stack)}</small></div><label>추가할 금액 $<input autoFocus inputMode="decimal" value={rebuyAmount} onChange={(event) => setRebuyAmount(event.target.value)} /></label><div><button onClick={() => setRebuySeatId('')}>취소</button><button className="primary" disabled={rebuyValue <= 0 || rebuyValue > rebuyProfile.balance} onClick={() => { onRebuy(rebuySeat.id, rebuyValue); setRebuySeatId('') }}>리바이 확정</button></div></div>}
    {game.seats.length < 6 && available.length > 0 && <div className="join-box"><h3>다음 핸드부터 참가</h3><select value={joinId} onChange={(e) => setJoinId(e.target.value)}><option value="">프로필 선택</option>{available.map((p) => <option value={p.id} key={p.id}>{p.name} · {fmt(p.balance)}</option>)}</select><label>바이인 $<input inputMode="decimal" value={buyIn} onChange={(e) => setBuyIn(e.target.value)} /></label><button className="secondary" onClick={() => { const p = profiles.find((x) => x.id === joinId); const value = parseMoney(buyIn); if (p && value > 0 && value <= p.balance) { onJoin(p, value); setJoinId('') } }}>참가 추가</button></div>}
    <button className="finish" onClick={onFinish}>전체 게임 종료 및 정산</button>
  </Drawer>
}

function EmergencyPanel({ game, onClose, onVoid, onEnd }: { game: Game; onClose: () => void; onVoid: () => void; onEnd: () => void }) {
  const contributions = game.seats.filter((seat) => seat.totalBet > 0)
  return <div className="overlay emergency-overlay" onMouseDown={onClose}><section className="emergency-panel" onMouseDown={(event) => event.stopPropagation()}>
    <div className="drawer-head"><div><span className="eyebrow danger-eyebrow">EMERGENCY CONTROL</span><h2>진행 중인 핸드 무효 처리</h2></div><button onClick={onClose}>×</button></div>
    <div className="refund-summary"><ChipVisual amount={potTotal(game)} /><div><small>각 플레이어에게 돌려줄 전체 베팅</small><b>{fmt(potTotal(game))}</b></div></div>
    <p>핸드 #{game.handNumber}의 결과와 폴드를 모두 취소하고, 블라인드를 포함해 이번 핸드에 낸 금액을 각 플레이어에게 그대로 반환합니다.</p>
    <div className="refund-list">{contributions.map((seat) => <div key={seat.id}><span>{seat.name}</span><b>+{fmt(seat.totalBet)} 반환</b></div>)}</div>
    <div className="emergency-actions">
      <button className="void-only" onClick={onVoid}><b>이 핸드만 무효 처리</b><small>베팅을 반환하고 같은 블라인드 위치에서 다시 진행합니다.</small></button>
      <button className="void-and-end" onClick={() => window.confirm('현재 핸드를 무효 처리하고 전체 게임을 즉시 정산·종료할까요?') && onEnd()}><b>무효 처리 후 게임 종료</b><small>베팅 반환 후 모든 테이블 칩을 프로필로 정산합니다.</small></button>
    </div>
    <small className="emergency-note">무효 처리 내역은 액션 기록과 종료된 게임 기록에 남습니다.</small>
  </section></div>
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="overlay" onMouseDown={onClose}><aside className="drawer" onMouseDown={(e) => e.stopPropagation()}><div className="drawer-head"><h2>{title}</h2><button onClick={onClose}>×</button></div>{children}</aside></div>
}

function HandHelp({ onClose }: { onClose: () => void }) {
  return <div className="overlay help-overlay" onMouseDown={onClose}><section className="help-card" onMouseDown={(e) => e.stopPropagation()}><div className="drawer-head"><div><span className="eyebrow">HAND RANKINGS</span><h2>텍사스 홀덤 족보</h2></div><button onClick={onClose}>×</button></div><p>내 카드 2장과 공용 카드 5장 중 가장 강한 5장 조합을 사용합니다. 아래로 갈수록 약한 족보입니다.</p><ol>{HELP.map(({ name, detail, cards }, i) => <li key={name}>
    <span className="ranking-number">{i + 1}</span>
    <div className="ranking-copy"><b>{name}</b><small>{detail}</small></div>
    <div className="card-example" role="img" aria-label={`${name} 예시: ${cards.join(', ')}`}>{cards.map((card, cardIndex) => {
      const suit = card.slice(-1)
      const rank = card.slice(0, -1)
      const red = suit === '♥' || suit === '♦'
      return <span className={`playing-card ${red ? 'red' : 'black'}`} data-suit={suit} key={`${card}-${cardIndex}`}><b>{rank}</b><i>{suit}</i></span>
    })}</div>
  </li>)}</ol><div className="tip"><b>동률이라면?</b> 조합을 구성하는 높은 숫자부터 비교합니다. 다섯 장이 완전히 같으면 팟을 똑같이 나눕니다. A는 스트레이트에서 10-J-Q-K-A의 위 또는 A-2-3-4-5의 아래로 사용할 수 있습니다.</div></section></div>
}

function History({ data, onBack }: { data: PersistedState; onBack: () => void }) {
  const profileMap = useMemo(() => Object.fromEntries(data.profiles.map((p) => [p.id, p.name])), [data.profiles])
  return <div className="page narrow history-page"><button className="back" onClick={onBack}>← 돌아가기</button><p className="eyebrow">LEDGER</p><h1>게임 및 잔액 기록</h1>
    <div className="history-grid"><section className="panel"><h2>최근 잔액 변동</h2><div className="transaction-list">{[...data.transactions].reverse().slice(0, 60).map((t) => <div key={t.id}><span><b>{profileMap[t.profileId] ?? t.profileName ?? '삭제된 프로필'}</b><small>{t.note} · {new Date(t.createdAt).toLocaleString('ko-KR')}</small></span><strong className={t.amount >= 0 ? 'plus' : 'minus'}>{t.amount >= 0 ? '+' : ''}{fmt(t.amount)}</strong></div>)}</div></section><section className="panel"><h2>종료된 게임</h2>{data.archives.length === 0 ? <p className="empty">아직 종료된 게임이 없습니다.</p> : data.archives.map((g) => <article className="archive" key={g.id}><b>{new Date(g.createdAt).toLocaleDateString('ko-KR')} · {g.seats.length}명</b><span>{g.handNumber}핸드 · {fmt(g.smallBlind)}/{fmt(g.bigBlind)}</span><small>{g.seats.map((s) => `${s.name} ${fmt(s.stack)}`).join(' · ')}</small></article>)}</section></div>
  </div>
}
