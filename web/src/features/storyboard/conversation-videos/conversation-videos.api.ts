import { useQuery } from '@tanstack/react-query'
import { conversationVideoJobsQuery } from '../storyboard.api'
import { groupConversationVideos } from './video-groups'

export const useConversationVideos = (conversationId: string) =>
  useQuery({ ...conversationVideoJobsQuery(conversationId), select: groupConversationVideos })
