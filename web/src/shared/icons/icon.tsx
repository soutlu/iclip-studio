import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  MessageSquare,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  AudioLines,
  Ban,
  Brush,
  Circle,
  CircleDot,
  Redo2,
  Square,
  Undo2,
  WandSparkles,
  BookOpen,
  Bot,
  CalendarDays,
  Captions,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeftRight,
  ChevronsUpDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clapperboard,
  Crop,
  Clock3,
  Database,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  Feather,
  FileBraces,
  FilePlus2,
  FileText,
  Folder,
  FolderClosed,
  Hand,
  History,
  Image,
  Info,
  LayoutGrid,
  Lightbulb,
  ListChecks,
  ListFilter,
  LoaderCircle,
  Mail,
  LockKeyhole,
  LogOut,
  PanelLeft,
  PanelRight,
  Pencil,
  Pipette,
  Play,
  Pause,
  Sun,
  Monitor,
  Moon,
  Music,
  Palette,
  Plus,
  RefreshCw,
  Repeat,
  Scissors,
  Search,
  Send,
  Settings,
  Split,
  Tag,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  Video,
  Volume2,
  VolumeOff,
  X,
  ZoomIn,
  Sparkles,
  Film,
  Layers,
  RotateCw,
  SlidersHorizontal,
  Cloud,
  Timer,
  RotateCcw,
  Wrench,
  Plug,
  ScanEye,
  KeyRound,
  Cpu,
  Link2,
  Star,
  Heading2,
  Bold,
  Italic,
  ListTree,
  Minimize,
  Keyboard,
  Scan,
} from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { FILE_GLYPHS } from './file-glyphs'
import { FINAL_CUT_GLYPHS } from './final-cut-glyphs'
import {
  ResourceAgentGlyph,
  ResourceFrameGlyph,
  ResourceMcpGlyph,
  ResourcePeopleGlyph,
  ResourcePersonGlyph,
  ResourcePluginGlyph,
  ResourceProjectGlyph,
  ResourceProviderGlyph,
  ResourceReferenceVideoGlyph,
  ResourceScriptBreakdownGlyph,
  ResourceShotsGlyph,
  ResourceSkillGlyph,
  ResourceStoryboardGlyph,
  ResourceUnderstandingGlyph,
  ResourceVideoGlyph,
  ResourceWorkspaceGlyph,
} from './resource-glyphs'

const LoadingGlyph = ({ strokeWidth: _strokeWidth, ...props }: LucideProps) => (
  <svg fill="none" viewBox="0 0 24 24" {...props}>
    <circle
      cx={12}
      cy={12}
      r={9}
      strokeWidth={2.2}
      style={{ stroke: 'var(--color-chat-hairline)' }}
    />
    <circle
      cx={12}
      cy={12}
      r={9}
      stroke="currentColor"
      strokeDasharray="56 56"
      strokeDashoffset={38}
      strokeLinecap="round"
      strokeWidth={2.2}
    />
  </svg>
)

const CopyGlyph = ({ strokeWidth: _strokeWidth, ...props }: LucideProps) => (
  <svg fill="none" viewBox="0 0 16 16" {...props}>
    <path
      d="M13.3334 5.33301H6.66671C5.93033 5.33301 5.33337 5.92996 5.33337 6.66634V13.333C5.33337 14.0694 5.93033 14.6663 6.66671 14.6663H13.3334C14.0698 14.6663 14.6667 14.0694 14.6667 13.333V6.66634C14.6667 5.92996 14.0698 5.33301 13.3334 5.33301Z"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.3}
    />
    <path
      d="M2.66671 10.6663C1.93337 10.6663 1.33337 10.0663 1.33337 9.33301V2.66634C1.33337 1.93301 1.93337 1.33301 2.66671 1.33301H9.33337C10.0667 1.33301 10.6667 1.93301 10.6667 2.66634"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.3}
    />
  </svg>
)

const ICONS = {
  'resource-agent': ResourceAgentGlyph,
  'resource-skill': ResourceSkillGlyph,
  'resource-reference-video': ResourceReferenceVideoGlyph,
  'resource-storyboard': ResourceStoryboardGlyph,
  'resource-script-breakdown': ResourceScriptBreakdownGlyph,
  'resource-workspace': ResourceWorkspaceGlyph,
  'resource-video': ResourceVideoGlyph,
  'resource-project': ResourceProjectGlyph,
  'resource-mcp': ResourceMcpGlyph,
  'resource-provider': ResourceProviderGlyph,
  'resource-plugin': ResourcePluginGlyph,
  'resource-shots': ResourceShotsGlyph,
  'resource-understanding': ResourceUnderstandingGlyph,
  'resource-frame': ResourceFrameGlyph,
  'resource-person': ResourcePersonGlyph,
  'resource-people': ResourcePeopleGlyph,
  add: Plus,
  arrow: ArrowUpRight,
  ellipse: Circle,
  rectangle: Square,
  point: CircleDot,
  pen: Brush,
  undo: Undo2,
  redo: Redo2,
  'edit-image': WandSparkles,
  'edit-video': Scissors,
  'edit-segment': WandSparkles,
  'add-file': FilePlus2,
  agent: Bot,
  appearance: Palette,
  'swap-panes': ArrowLeftRight,
  message: MessageSquare,
  alert: CircleAlert,
  audio: Volume2,
  'audio-off': VolumeOff,
  back: ArrowLeft,
  blocked: Ban,
  calendar: CalendarDays,
  captions: Captions,
  chart: ChartColumn,
  check: Check,
  close: X,
  collapse: ChevronUp,
  collection: FolderClosed,
  compare: ChevronsLeftRight,
  compose: Feather,
  confirm: Hand,
  copy: CopyGlyph,
  crop: Crop,
  delete: Trash2,
  download: Download,
  disclosure: ChevronRight,
  dropdown: ChevronsUpDown,
  duration: Clock3,
  edit: Pencil,
  expand: ChevronDown,
  external: ExternalLink,
  failed: CircleX,
  file: FileText,
  'file-json': FileBraces,
  filter: ListFilter,
  folder: Folder,
  fork: Split,
  grid: LayoutGrid,
  hidden: EyeOff,
  history: History,
  image: Image,
  info: Info,
  library: Database,
  loading: LoadingGlyph,
  mail: Mail,
  locked: LockKeyhole,
  logout: LogOut,
  more: Ellipsis,
  'move-up': ArrowUp,
  'move-down': ArrowDown,
  music: Music,
  next: ArrowRight,
  'panel-left': PanelLeft,
  'panel-right': PanelRight,
  play: Play,
  pause: Pause,
  preview: Eye,
  reference: BookOpen,
  refresh: RefreshCw,
  replace: Repeat,
  search: Search,
  send: Send,
  'send-up': ArrowUp,
  settings: Settings,
  spinner: LoaderCircle,
  stop: Square,
  success: CircleCheck,
  tag: Tag,
  task: ListChecks,
  'theme-dark': Moon,
  'theme-light': Sun,
  'theme-system': Monitor,
  thinking: Lightbulb,
  'to-bottom': ArrowDown,
  upload: Upload,
  user: User,
  video: Video,
  'video-type': Clapperboard,
  composite: Clapperboard,
  included: Eye,
  excluded: EyeOff,
  warning: TriangleAlert,
  waveform: AudioLines,
  zoom: ZoomIn,
  sparkles: Sparkles,
  film: Film,
  layers: Layers,
  rotate: RotateCw,
  eyedropper: Pipette,
  manage: SlidersHorizontal,
  provider: Cloud,
  timeout: Timer,
  'max-calls': Repeat,
  restore: RotateCcw,
  skill: BookOpen,
  credential: KeyRound,
  model: Cpu,
  link: Link2,
  'make-default': Star,
  plugin: Wrench,
  'mcp-server': Plug,
  'video-understanding': ScanEye,
  'shot-list': ListTree,
  heading: Heading2,
  bold: Bold,
  italic: Italic,
  'exit-fullscreen': Minimize,
  shortcuts: Keyboard,
  'zoom-selection': Scan,
  ...FINAL_CUT_GLYPHS,
  ...FILE_GLYPHS,
} as const

export type IconName = keyof typeof ICONS

type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

const SIZE_CLASS: Record<IconSize, string> = {
  xs: 'size-(--icon-xs)',
  sm: 'size-(--icon-sm)',
  md: 'size-(--icon-md)',
  lg: 'size-(--icon-lg)',
  xl: 'size-(--icon-xl)',
}

type IconProps = {
  name: IconName
  size?: IconSize
  className?: string
} & ({ label: string; decorative?: never } | { decorative: true; label?: never })

export function Icon({ name, size = 'md', className, ...intent }: IconProps) {
  const label = 'label' in intent ? intent.label : undefined
  if (!label && !('decorative' in intent)) {
    throw new Error(`Icon "${name}" 缺少 label：语义图标必须传 label，装饰图标必须传 decorative`)
  }

  const Glyph = ICONS[name]
  return (
    <Glyph
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className={cn(SIZE_CLASS[size], className)}
      focusable={false}
      role={label ? 'img' : undefined}
      strokeWidth={2}
    />
  )
}
