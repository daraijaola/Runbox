#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env};

#[contracttype]
#[derive(Clone, Debug)]
pub struct AgentBudget {
    pub total_limit: i128,
    pub spent: i128,
    pub per_call_limit: i128,
    pub active: bool,
}

#[contracttype]
pub enum DataKey {
    Admin,
    Budget(Address),
    ServiceAddr,
}

#[contract]
pub struct SpendingCapContract;

#[contractimpl]
impl SpendingCapContract {
    /// Initialize the contract with admin and RunBox service address.
    pub fn init(env: Env, admin: Address, service: Address) {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::ServiceAddr, &service);
    }

    /// Agent registers a spending budget.
    /// total_limit: max USDC (in stroops) the agent can spend total.
    /// per_call_limit: max USDC per individual execution call.
    pub fn register_budget(
        env: Env,
        agent: Address,
        total_limit: i128,
        per_call_limit: i128,
    ) {
        agent.require_auth();

        let budget = AgentBudget {
            total_limit,
            spent: 0,
            per_call_limit,
            active: true,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Budget(agent.clone()), &budget);

        env.events()
            .publish((symbol_short!("register"),), (agent, total_limit, per_call_limit));
    }

    /// RunBox service calls this before executing code.
    /// Returns true if the agent has sufficient budget, and deducts the amount.
    pub fn authorize_spend(env: Env, agent: Address, amount: i128) -> bool {
        let service: Address = env
            .storage()
            .instance()
            .get(&DataKey::ServiceAddr)
            .expect("not initialized");
        service.require_auth();

        let key = DataKey::Budget(agent.clone());
        let mut budget: AgentBudget = env
            .storage()
            .persistent()
            .get(&key)
            .expect("no budget registered");

        if !budget.active {
            return false;
        }

        if amount > budget.per_call_limit {
            return false;
        }

        if budget.spent + amount > budget.total_limit {
            return false;
        }

        budget.spent += amount;
        env.storage().persistent().set(&key, &budget);

        env.events()
            .publish((symbol_short!("spend"),), (agent, amount, budget.spent));

        true
    }

    /// Agent checks remaining budget.
    pub fn get_budget(env: Env, agent: Address) -> AgentBudget {
        env.storage()
            .persistent()
            .get(&DataKey::Budget(agent))
            .expect("no budget registered")
    }

    /// Agent deactivates their budget (emergency stop).
    pub fn pause_budget(env: Env, agent: Address) {
        agent.require_auth();
        let key = DataKey::Budget(agent.clone());
        let mut budget: AgentBudget = env
            .storage()
            .persistent()
            .get(&key)
            .expect("no budget registered");

        budget.active = false;
        env.storage().persistent().set(&key, &budget);

        env.events().publish((symbol_short!("pause"),), (agent,));
    }

    /// Agent resumes their budget.
    pub fn resume_budget(env: Env, agent: Address) {
        agent.require_auth();
        let key = DataKey::Budget(agent.clone());
        let mut budget: AgentBudget = env
            .storage()
            .persistent()
            .get(&key)
            .expect("no budget registered");

        budget.active = true;
        env.storage().persistent().set(&key, &budget);

        env.events().publish((symbol_short!("resume"),), (agent,));
    }

    /// Admin updates the service address.
    pub fn set_service(env: Env, admin: Address, new_service: Address) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        assert!(admin == stored_admin, "not admin");

        env.storage()
            .instance()
            .set(&DataKey::ServiceAddr, &new_service);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::Env;

    #[test]
    fn test_full_flow() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpendingCapContract);
        let client = SpendingCapContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let service = Address::generate(&env);
        let agent = Address::generate(&env);

        client.init(&admin, &service);

        // Agent registers budget: 1000 stroops total, 100 per call
        client.register_budget(&agent, &1000, &100);

        let budget = client.get_budget(&agent);
        assert_eq!(budget.total_limit, 1000);
        assert_eq!(budget.spent, 0);
        assert_eq!(budget.per_call_limit, 100);
        assert!(budget.active);

        // Service authorizes a spend of 50
        assert!(client.authorize_spend(&agent, &50));

        let budget = client.get_budget(&agent);
        assert_eq!(budget.spent, 50);

        // Service authorizes another 50
        assert!(client.authorize_spend(&agent, &50));
        let budget = client.get_budget(&agent);
        assert_eq!(budget.spent, 100);

        // Try to spend more than per-call limit
        assert!(!client.authorize_spend(&agent, &150));

        // Pause budget
        client.pause_budget(&agent);
        assert!(!client.authorize_spend(&agent, &10));

        // Resume
        client.resume_budget(&agent);
        assert!(client.authorize_spend(&agent, &10));
    }

    #[test]
    fn test_budget_exhaustion() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SpendingCapContract);
        let client = SpendingCapContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let service = Address::generate(&env);
        let agent = Address::generate(&env);

        client.init(&admin, &service);
        client.register_budget(&agent, &100, &50);

        assert!(client.authorize_spend(&agent, &50));
        assert!(client.authorize_spend(&agent, &50));
        // Budget exhausted
        assert!(!client.authorize_spend(&agent, &1));
    }
}
