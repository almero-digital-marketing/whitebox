export default ({ webhooksConfig, events, webhooks }) => {
  async function notify(type, payload) {
    await events.publish(type, payload)
    const key = type.split('.').pop()
    if (webhooksConfig?.[key]) {
      await webhooks.send({ ...webhooksConfig[key], data: payload })
    }
  }

  return { notify }
}
