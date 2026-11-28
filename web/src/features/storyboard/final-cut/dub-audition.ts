export const DUB_AUDITION = 'dub:'

/** 单句试听在共用试听里的编号：按配音片段算，重配后换了片段就是另一条。 */
export const dubAuditionId = (dubId: string) => `${DUB_AUDITION}${dubId}`
