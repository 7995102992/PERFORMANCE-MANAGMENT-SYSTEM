package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCycleApplicabilityEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsCycleApplicabilityRepository extends JpaRepository<PmsCycleApplicabilityEntity, UUID> {

    Optional<PmsCycleApplicabilityEntity> findByCycleId(UUID cycleId);

    void deleteByCycleId(UUID cycleId);
}
