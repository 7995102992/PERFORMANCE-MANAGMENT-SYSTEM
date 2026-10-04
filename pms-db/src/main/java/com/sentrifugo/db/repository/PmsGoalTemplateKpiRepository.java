package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateKpiEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsGoalTemplateKpiRepository extends JpaRepository<PmsGoalTemplateKpiEntity, UUID> {

    List<PmsGoalTemplateKpiEntity> findByTemplateIdOrderByDisplayOrderAsc(UUID templateId);

    void deleteByTemplateId(UUID templateId);

    boolean existsByKpiId(UUID kpiId);
}
