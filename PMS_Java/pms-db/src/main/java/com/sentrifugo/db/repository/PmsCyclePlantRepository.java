package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsCyclePlantEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsCyclePlantRepository extends JpaRepository<PmsCyclePlantEntity, UUID> {

    List<PmsCyclePlantEntity> findByCycleId(UUID cycleId);

    void deleteByCycleId(UUID cycleId);
}
