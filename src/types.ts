export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'
export type GamePhase = 'between-hands' | 'playing' | 'showdown' | 'finished'
export type PlayerState = 'active' | 'folded' | 'all-in' | 'sitting-out'

export interface Profile {
  id: string
  name: string
  balance: number
  createdAt: string
}

export interface Seat {
  id: string
  profileId: string
  name: string
  seat: number
  stack: number
  state: PlayerState
  sittingOutNextHand: boolean
  joinedAtHand: number
  streetBet: number
  totalBet: number
  owesEntryBlind?: boolean
  buyInTotal?: number
  handsPlayed?: number
  handsWon?: number
}

export interface ActionLog {
  id: string
  hand: number
  street: Street
  seatId?: string
  text: string
  createdAt: string
}

export interface Game {
  id: string
  createdAt: string
  smallBlind: number
  bigBlind: number
  phase: GamePhase
  street: Street
  handNumber: number
  buttonSeat: number | null
  /** Legacy storage field; migrated to buttonSeat when loaded. */
  dealerSeat?: number | null
  smallBlindSeat?: number | null
  bigBlindSeat?: number | null
  currentActorId: string | null
  currentBet: number
  minRaise: number
  communityCardsRevealed?: number
  awaitingBoard?: boolean
  seats: Seat[]
  needsAction: string[]
  lastActedBet: Record<string, number>
  /** Legacy storage field. */
  actedSinceFullRaise?: string[]
  repeatButtonNextHand?: boolean
  participatingProfileIds?: string[]
  departedSeats?: Seat[]
  layoutVersion?: number
  logs: ActionLog[]
}

export type PokerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; total: number }
  | { type: 'raise'; total: number }
  | { type: 'all-in' }

export interface SidePot {
  id: string
  amount: number
  eligibleSeatIds: string[]
  automatic: boolean
  uncalledReturn?: boolean
}

export interface Transaction {
  id: string
  profileId: string
  profileName?: string
  amount: number
  type: 'opening' | 'adjustment' | 'buy-in' | 'cash-out'
  note: string
  createdAt: string
}

export interface PersistedState {
  profiles: Profile[]
  game: Game | null
  transactions: Transaction[]
  archives: Game[]
}
