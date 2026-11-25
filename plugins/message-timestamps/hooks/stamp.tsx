import type { ClientModule } from 'claude-code'

type Props = { stamp: string; hover: string }

/** The timestamp, swapped for the hover text while the pointer is on it. */
const Stamp: ClientModule<Props, { isOver: boolean }> = (props, surface) => {
  surface.onPointer(event => {
    const isOver = event.type !== 'leave'
    if (isOver !== (surface.state?.isOver ?? false)) surface.setState({ isOver })
  })
  const { Text } = surface.elements

  return <Text dimColor>{surface.state?.isOver ? props.hover : props.stamp}</Text>
}

export default Stamp
