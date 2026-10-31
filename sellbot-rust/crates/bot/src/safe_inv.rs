use azalea::container::ContainerHandleRef;
use azalea::entity::inventory::Inventory;
use azalea::prelude::*;

pub fn try_close(bot: &Client) -> bool {
    let Some(inv) = bot.get_component::<Inventory>() else {
        return false;
    };
    if inv.id == 0 {
        return false;
    }
    ContainerHandleRef::new(inv.id, bot.clone()).close();
    true
}
